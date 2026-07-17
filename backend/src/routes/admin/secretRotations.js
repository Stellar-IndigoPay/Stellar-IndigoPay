"use strict";

/**
 * src/routes/admin/secretRotations.js
 *
 * Admin API endpoints for inspecting the secret rotation audit log.
 * The rotation workflow (`.github/workflows/secret-rotation.yml`) writes a
 * row to the `secret_rotations` table after each rotation cycle. This
 * router lets administrators list past rotations, view the details of a
 * specific rotation, and, if needed, manually trigger a rotation entry
 * for externally-performed rotations.
 *
 * Mounted at /api/admin/secret-rotations (see routes/admin.js).
 * All routes require admin authentication.
 */

const express = require("express");
const { v4: uuid } = require("uuid");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { updateSecretRotationMetrics } = require("../../services/metrics");

router.use(adminRequired);

const VALID_STATUSES = ["in_progress", "completed", "failed", "rolled_back"];
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * Format a single rotation row for the JSON response.
 */
function mapRotationRow(row) {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    triggeredBy: row.triggered_by,
    secretsRotated: row.secrets_rotated || [],
    esoForceSyncTriggeredAt: row.eso_force_sync_triggered_at
      ? new Date(row.eso_force_sync_triggered_at).toISOString()
      : null,
    rollingRestartStartedAt: row.rolling_restart_started_at
      ? new Date(row.rolling_restart_started_at).toISOString()
      : null,
    rollingRestartCompletedAt: row.rolling_restart_completed_at
      ? new Date(row.rolling_restart_completed_at).toISOString()
      : null,
    healthCheckPassed: row.health_check_passed,
    rollbackTriggered: row.rollback_triggered,
    rollbackReason: row.rollback_reason || null,
    overallStatus: row.overall_status,
    startedAt: new Date(row.started_at).toISOString(),
    completedAt: row.completed_at
      ? new Date(row.completed_at).toISOString()
      : null,
    metadata: row.metadata || {},
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * GET /api/admin/secret-rotations
 *
 * List past secret rotations, most recent first, with optional filtering
 * by status and pagination.
 *
 * Query params:
 *   - status: filter by overall_status (in_progress|completed|failed|rolled_back)
 *   - page: page number (default 1)
 *   - pageSize: items per page (default 20, max 100)
 */
router.get("/", async (req, res, next) => {
  try {
    const { status } = req.query;
    const page = Math.max(Number.parseInt(req.query.page, 10) || 1, 1);
    const pageSize = Math.min(
      Number.parseInt(req.query.pageSize, 10) || DEFAULT_PAGE_SIZE,
      MAX_PAGE_SIZE,
    );
    const offset = (page - 1) * pageSize;

    const where = [];
    const values = [];

    if (status && VALID_STATUSES.includes(status)) {
      values.push(status);
      where.push(`sr.overall_status = $${values.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM secret_rotations sr ${whereClause}`,
      values,
    );

    const listValues = [...values, pageSize, offset];
    const result = await pool.query(
      `SELECT * FROM secret_rotations sr
       ${whereClause}
       ORDER BY sr.started_at DESC
       LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );

    res.json({
      success: true,
      data: result.rows.map(mapRotationRow),
      total: countResult.rows[0].total,
      page,
      pageSize,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/secret-rotations/:id
 *
 * Get the full detail of a single secret rotation event.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM secret_rotations WHERE id = $1",
      [id],
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: { code: "NOT_FOUND", message: "Secret rotation not found" },
      });
    }

    res.json({
      success: true,
      data: mapRotationRow(result.rows[0]),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/admin/secret-rotations
 *
 * Manually record a secret rotation event. This can be used by operators
 * for externally-performed rotations or to backfill audit entries.
 *
 * Body:
 *   - workflowRunId (string, optional): GitHub Actions run ID
 *   - triggeredBy (string): who/what triggered the rotation
 *   - secretsRotated (string[]): list of secret names that were rotated
 *   - overallStatus (string): in_progress|completed|failed|rolled_back
 *   - healthCheckPassed (boolean, optional)
 *   - rollbackTriggered (boolean, optional)
 *   - metadata (object, optional)
 */
router.post("/", async (req, res, next) => {
  try {
    const {
      workflowRunId,
      triggeredBy = "manual",
      secretsRotated = [],
      overallStatus = "completed",
      healthCheckPassed,
      rollbackTriggered = false,
      rollbackReason,
      metadata = {},
    } = req.body || {};

    if (!Array.isArray(secretsRotated) || secretsRotated.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "secretsRotated must be a non-empty array of secret names",
        },
      });
    }

    if (!VALID_STATUSES.includes(overallStatus)) {
      return res.status(400).json({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: `overallStatus must be one of: ${VALID_STATUSES.join(", ")}`,
        },
      });
    }

    const id = uuid();
    const now = new Date();
    const completedAt = overallStatus !== "in_progress" ? now : null;

    await pool.query(
      `INSERT INTO secret_rotations
         (id, workflow_run_id, triggered_by, secrets_rotated,
          health_check_passed, rollback_triggered, rollback_reason,
          overall_status, started_at, completed_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        id,
        workflowRunId || null,
        triggeredBy,
        secretsRotated,
        healthCheckPassed ?? null,
        rollbackTriggered,
        rollbackReason || null,
        overallStatus,
        now,
        completedAt,
        JSON.stringify(metadata),
      ],
    );

    logAdminAction({
      actor: (req.admin && req.admin.sub) || "admin",
      action: "secret_rotation.manual_record",
      targetType: "secret_rotation",
      targetId: id,
      metadata: { secretsRotated, overallStatus },
      ipAddress: req.ip,
    });

    // Update the Prometheus gauge so the SecretRotationFailed / Stuck / Overdue
    // alerts can fire based on live metric data.
    updateSecretRotationMetrics(overallStatus);

    const result = await pool.query(
      "SELECT * FROM secret_rotations WHERE id = $1",
      [id],
    );

    res.status(201).json({
      success: true,
      data: mapRotationRow(result.rows[0]),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/secret-rotations/latest/status
 *
 * Quick status of the most recent rotation. Useful for dashboards and
 * automated monitoring.
 */
router.get("/latest/status", async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, overall_status, health_check_passed, rollback_triggered,
              started_at, completed_at
       FROM secret_rotations
       ORDER BY started_at DESC
       LIMIT 1`,
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        data: {
          hasRotations: false,
          lastRotation: null,
        },
      });
    }

    const row = result.rows[0];
    res.json({
      success: true,
      data: {
        hasRotations: true,
        lastRotation: {
          id: row.id,
          overallStatus: row.overall_status,
          healthCheckPassed: row.health_check_passed,
          rollbackTriggered: row.rollback_triggered,
          startedAt: new Date(row.started_at).toISOString(),
          completedAt: row.completed_at
            ? new Date(row.completed_at).toISOString()
            : null,
        },
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
