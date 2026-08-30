/**
 * src/routes/admin/updatesModeration.js
 *
 * Admin review queue for the project-update content-moderation pipeline
 * (issue #935). Mounted at /api/admin/updates/moderation (and /api/v1/...).
 *
 * GET  /              — review queue, filterable by moderation status
 * GET  /:id           — detail (update + screening trail + abuse reports)
 * POST /:id/decide    — approve | quarantine | remove (audited)
 *
 * `decide` routes through services/moderation.decideModeration, which owns
 * the row lock (SELECT ... FOR UPDATE) so a concurrent auto re-screen can't
 * race an admin decision, attributes the reviewer, and writes the auditChain
 * entry. `remove` is terminal: removed rows are hidden indefinitely and
 * suppressed from digests.
 */
"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { AppError } = require("../../errors");
const { mapProjectUpdateRow } = require("../../services/store");
const { decideModeration } = require("../../services/moderation");

const VALID_STATUS = new Set([
  "pending-screening",
  "live",
  "quarantined",
  "removed",
]);
const VALID_DECISIONS = new Set(["approve", "quarantine", "remove"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(adminRequired);

/**
 * GET /api/admin/updates/moderation — review queue.
 *
 * ?status=pending-screening,quarantined   — filter (comma-separated).
 *   Default (no filter) shows the actionable queue: pending-screening +
 *   quarantined (i.e. everything needing a human). Pass `status=live` or
 *   `status=removed` explicitly for the full history.
 * ?projectId=uuid — narrow to one project.
 */
router.get("/", async (req, res, next) => {
  try {
    const { status, projectId } = req.query;

    const conditions = [];
    const values = [];

    if (status) {
      const statuses = String(status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (statuses.length === 0 || statuses.some((s) => !VALID_STATUS.has(s))) {
        throw new AppError("VALIDATION_ERROR", {
          field: "status",
          message: `status must be one of: ${[...VALID_STATUS].join(", ")}`,
        });
      }
      values.push(statuses);
      conditions.push(
        `pu.moderation_status = ANY($${values.length}::text[])`,
      );
    } else {
      conditions.push(
        `pu.moderation_status IN ('pending-screening', 'quarantined')`,
      );
    }

    if (projectId) {
      if (!UUID_RE.test(projectId)) {
        throw new AppError("VALIDATION_ERROR", { field: "projectId" });
      }
      values.push(projectId);
      conditions.push(`pu.project_id = $${values.length}`);
    }

    const whereClause = conditions.length
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const result = await pool.query(
      `SELECT pu.*,
              p.name AS project_name,
              (SELECT COUNT(*) FROM update_abuse_reports ur WHERE ur.update_id = pu.id)::int AS abuse_report_count
         FROM project_updates pu
         JOIN projects p ON pu.project_id = p.id
         ${whereClause}
         ORDER BY pu.created_at DESC
         LIMIT 200`,
      values,
    );

    return res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...mapProjectUpdateRow(row),
        projectName: row.project_name,
        abuseReportCount: Number(row.abuse_report_count || 0),
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/updates/moderation/:id — detail with reports + screening.
 * Abuse reports are listed (reason, hashed IP, timestamp) so reviewers have
 * the full context before deciding; raw reporter IPs are never stored.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new AppError("VALIDATION_ERROR", { field: "id" });
    }

    const result = await pool.query(
      `SELECT pu.*, p.name AS project_name
         FROM project_updates pu
         JOIN projects p ON pu.project_id = p.id
        WHERE pu.id = $1`,
      [id],
    );
    if (!result.rows[0]) {
      throw new AppError("NOT_FOUND", { message: "Update not found" });
    }

    const reports = await pool.query(
      "SELECT id, reporter, reason, ip_hash IS NOT NULL AS has_ip, created_at FROM update_abuse_reports WHERE update_id = $1 ORDER BY created_at DESC",
      [id],
    );

    return res.json({
      success: true,
      data: {
        ...mapProjectUpdateRow(result.rows[0]),
        projectName: result.rows[0].project_name,
        abuseReports: reports.rows,
      },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * POST /api/admin/updates/moderation/:id/decide
 *
 * Body: { decision: "approve" | "quarantine" | "remove", rationale?: string }
 * The reviewer is taken from the authenticated admin context so decisions
 * are attributable; every decision is written to the auditChain log.
 */
router.post("/:id/decide", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new AppError("VALIDATION_ERROR", { field: "id" });
    }

    const { decision, rationale } = req.body || {};
    if (!decision || !VALID_DECISIONS.has(decision)) {
      throw new AppError("VALIDATION_ERROR", {
        field: "decision",
        message: `decision must be one of: ${[...VALID_DECISIONS].join(", ")}`,
      });
    }
    if (rationale !== undefined && typeof rationale !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "rationale" });
    }

    const reviewer = req.admin?.sub || "admin";
    const outcome = await decideModeration({
      updateId: id,
      decision,
      reviewer,
      rationale: rationale || null,
      ipAddress: req.ip,
    });

    if (!outcome.okay) {
      if (outcome.error === "update_not_found") {
        throw new AppError("UPDATE_NOT_FOUND");
      }
      throw new AppError("INVALID_STATE_TRANSITION", {
        message: outcome.error,
      });
    }

    return res.json({ success: true, data: outcome.update });
  } catch (e) {
    next(e);
  }
});

module.exports = router;