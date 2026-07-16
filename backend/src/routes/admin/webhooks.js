"use strict";

/**
 * src/routes/admin/webhooks.js — Webhook dead-letter queue management
 *
 * The webhook delivery pipeline (services/webhookQueue.js) retries a
 * project-milestone webhook 6 times with exponential backoff before
 * writing it to `webhook_deliveries.status = 'dlq'` (and a snapshot row
 * in `webhook_dlq`). Without an admin surface, a temporary outage on a
 * project's webhook endpoint permanently loses those events. This router
 * lets an admin inspect the dead-letter queue, replay individual or
 * project-wide failures, and review delivery history.
 *
 * Mounted at /api/admin/webhooks (see routes/admin.js). All routes are
 * admin-only.
 */

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { replayDelivery } = require("../../services/webhookQueue");

router.use(adminRequired);

const VALID_STATUSES = ["pending", "delivered", "failed", "dlq"];

function mapDeliveryRow(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    projectName: row.project_name || null,
    eventId: row.event_id,
    eventType: row.event_type,
    status: row.status,
    attempts: row.attempts,
    lastAttemptAt: row.last_attempt_at
      ? new Date(row.last_attempt_at).toISOString()
      : null,
    lastError: row.last_error || null,
    nextAttemptAt: row.next_attempt_at
      ? new Date(row.next_attempt_at).toISOString()
      : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * GET /api/admin/webhooks/dead-letter?projectId=&limit=&page=
 * Lists deliveries currently sitting in the dead-letter state.
 */
router.get("/dead-letter", async (req, res, next) => {
  try {
    const { projectId } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const offset = (page - 1) * limit;

    const where = ["d.status = 'dlq'"];
    const values = [];
    if (projectId) {
      values.push(projectId);
      where.push(`d.project_id = $${values.length}`);
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
         FROM webhook_deliveries d
        WHERE ${where.join(" AND ")}`,
      values,
    );

    const listValues = [...values, limit, offset];
    const result = await pool.query(
      `SELECT d.*, p.name AS project_name
         FROM webhook_deliveries d
         JOIN projects p ON p.id = d.project_id
        WHERE ${where.join(" AND ")}
        ORDER BY d.updated_at DESC
        LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
      listValues,
    );

    res.json({
      success: true,
      data: result.rows.map(mapDeliveryRow),
      total: countResult.rows[0].total,
      page,
      pageSize: limit,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/admin/webhooks/dead-letter/:deliveryId/replay
 * Replays a single dead-lettered delivery, resetting its attempt budget
 * and immediately retrying.
 */
router.post("/dead-letter/:deliveryId/replay", async (req, res, next) => {
  try {
    const { deliveryId } = req.params;
    const replayed = await replayDelivery(deliveryId);
    if (!replayed) {
      return res
        .status(404)
        .json({ error: "No dead-lettered delivery found with that id" });
    }

    const result = await pool.query(
      "SELECT * FROM webhook_deliveries WHERE id = $1",
      [deliveryId],
    );

    logAdminAction({
      actor: (req.admin && req.admin.sub) || "admin",
      action: "webhook.dead_letter.replay",
      targetType: "webhook_delivery",
      targetId: deliveryId,
      metadata: { status: result.rows[0]?.status },
      ipAddress: req.ip,
    });

    res.json({ success: true, data: mapDeliveryRow(result.rows[0]) });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/admin/webhooks/dead-letter/replay-all
 * Body: { projectId: string }
 * Replays every dead-lettered delivery for a project, sequentially (the
 * dataset is admin-scale, not high-volume, so a simple loop is enough —
 * no extra queueing infrastructure needed).
 */
router.post("/dead-letter/replay-all", async (req, res, next) => {
  try {
    const { projectId } = req.body || {};
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required" });
    }

    const result = await pool.query(
      "SELECT id FROM webhook_deliveries WHERE project_id = $1 AND status = 'dlq'",
      [projectId],
    );

    let count = 0;
    for (const row of result.rows) {
      const replayed = await replayDelivery(row.id);
      if (replayed) count++;
    }

    logAdminAction({
      actor: (req.admin && req.admin.sub) || "admin",
      action: "webhook.dead_letter.replay_all",
      targetType: "project",
      targetId: projectId,
      metadata: { count },
      ipAddress: req.ip,
    });

    res.json({ success: true, count });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/webhooks/deliveries?projectId=&status=&limit=
 * Delivery history for a project (or across all projects), most recent first.
 */
router.get("/deliveries", async (req, res, next) => {
  try {
    const { projectId, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    const where = [];
    const values = [];
    if (projectId) {
      values.push(projectId);
      where.push(`d.project_id = $${values.length}`);
    }
    if (status && VALID_STATUSES.includes(status)) {
      values.push(status);
      where.push(`d.status = $${values.length}`);
    }

    values.push(limit);
    const result = await pool.query(
      `SELECT d.*, p.name AS project_name
         FROM webhook_deliveries d
         JOIN projects p ON p.id = d.project_id
         ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY d.created_at DESC
        LIMIT $${values.length}`,
      values,
    );

    res.json({ success: true, data: result.rows.map(mapDeliveryRow) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
