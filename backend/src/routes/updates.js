/**
 * src/routes/updates.js
 * GET  /api/updates/:projectId        — list live updates for a project (cursor pagination)
 * POST /api/updates                   — create update + notify subscribers (admin)
 * POST /api/updates/:updateId/report  — staff abuse-report → quarantine (admin)
 *
 * Content moderation (issue #935): every submission is screened inline with
 * the deterministic rule engine before it is allowed to touch subscribers.
 *   - hard rule violation -> rows are inserted `quarantined` (auto-quarantine
 *     + alert); subscribers are never notified.
 *   - soft signal          -> inserted `pending-screening`; the background
 *     AI screening decides, and only `/updates.js`'s `onLive` callback is
 *     allowed to notify, so notifications can never fire for non-live rows.
 *   - clean                -> inserted `live` straight away.
 * The public read path filters on moderation_status = 'live', so quarantined
 * and removed content is hidden without a full delete.
 */
"use strict";
const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const { v4: uuidv4 } = require("uuid");
const pool = require("../db/pool");
const { mapProjectUpdateRow, mapProjectRow } = require("../services/store");
const { sendUpdateNotifications } = require("../services/email");
const { AppError } = require("../errors");
const { enqueuePushNotification } = require("../services/pushQueue");
const {
  runRuleScreening,
  DECISION,
} = require("../services/screeningRules");
const {
  screenProjectUpdate,
  raiseModerationAlert,
} = require("../services/moderation");
const { logAdminAction } = require("../services/audit");

const { adminRequired } = require("../middleware/auth");
const { validateRouteParam } = require("../middleware/validate");
const { uuid: uuidValidator } = require("../validators/schemas");

router.param("projectId", validateRouteParam(uuidValidator, "projectId"));
router.param("updateId", validateRouteParam(uuidValidator, "updateId"));

/**
 * Authorised notification fan-out for a *live* update. This is the only place
 * in the codebase that may email/push an update — callers decide moderation
 * before ever reaching it.
 */
function notifySubscribersForLive(project, update) {
  pool
    .query("SELECT email FROM project_subscriptions WHERE project_id = $1", [
      project.id,
    ])
    .then(({ rows }) => {
      const emails = rows.map((r) => r.email);
      return sendUpdateNotifications({ project, update, emails });
    })
    .catch((err) => {
      console.error(
        "[updates] Failed to send email notifications:",
        err.message,
      );
    });

  enqueuePushNotification({
    type: "project_update",
    payload: { project, update },
  }).catch((err) => {
    console.error(
      "[updates] Failed to send push notifications:",
      err.message,
    );
  });
}

// GET /api/updates/:projectId
// Cursor pagination by (created_at, id) to support infinite scroll.
// Only `live` rows are ever readable — the moderation filter is the boundary
// that keeps quarantined/removed content off the public feed.
router.get("/:projectId", async (req, res, next) => {
  try {
    const { limit = 10, cursor } = req.query;
    const pageSize = Math.min(Number.parseInt(limit, 10) || 10, 100);

    const values = [req.params.projectId];
    const where = ["project_id = $1", "moderation_status = 'live'"];

    if (cursor) {
      let cursorData;
      try {
        cursorData = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
      } catch {
        throw new AppError("INVALID_CURSOR");
      }

      const { created_at, id } = cursorData;
      if (!created_at || !id) {
        throw new AppError("INVALID_CURSOR");
      }

      values.push(created_at, id);
      const createdAtIdx = values.length - 1;
      const idIdx = values.length;
      where.push(
        `(created_at < $${createdAtIdx} OR (created_at = $${createdAtIdx} AND id < $${idIdx}))`,
      );
    }

    values.push(pageSize + 1);
    const limitIdx = values.length;

    const result = await pool.query(
      `SELECT *
       FROM project_updates
       WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC, id DESC
       LIMIT $${limitIdx}`,
      values,
    );

    const rows = result.rows;
    const hasMore = rows.length > pageSize;
    const pageRows = rows.slice(0, pageSize);

    let nextCursor = null;
    if (hasMore) {
      const last = pageRows[pageRows.length - 1];
      nextCursor = Buffer.from(
        JSON.stringify({ created_at: last.created_at, id: last.id }),
      ).toString("base64");
    }

    res.json({
      success: true,
      data: pageRows.map(mapProjectUpdateRow),
      next_cursor: nextCursor,
      has_more: hasMore,
    });
  } catch (e) {
    next(e);
  }
});

// POST /api/updates  (admin only)
router.post("/", adminRequired, async (req, res, next) => {
  try {
    const { projectId, title, body } = req.body;

    if (!projectId || typeof projectId !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "projectId" });
    }
    if (!title || typeof title !== "string" || !title.trim()) {
      throw new AppError("VALIDATION_ERROR", { field: "title" });
    }
    if (!body || typeof body !== "string" || !body.trim()) {
      throw new AppError("VALIDATION_ERROR", { field: "body" });
    }

    // Verify project exists
    const projResult = await pool.query(
      "SELECT * FROM projects WHERE id = $1",
      [projectId],
    );
    if (!projResult.rows[0]) throw new AppError("PROJECT_NOT_FOUND");
    const project = mapProjectRow(projResult.rows[0]);

    // Deterministic rule screening (no I/O, no AI — a pure fast path).
    // The full AI trail for "review" cases is appended by the background
    // screening in services/moderation.js.
    const rules = runRuleScreening({ title, body: body.trim() });
    const screening = { rules, ai: null };

    let moderationStatus;
    if (rules.decision === DECISION.QUARANTINE) {
      moderationStatus = "quarantined";
    } else if (rules.decision === DECISION.REVIEW) {
      moderationStatus = "pending-screening";
    } else {
      moderationStatus = "live";
    }

    // Insert update with its moderation state set at submission time.
    const id = uuidv4();
    const insertResult = await pool.query(
      `INSERT INTO project_updates (id, project_id, title, body, moderation_status, moderation_screening)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        projectId,
        title.trim(),
        body.trim(),
        moderationStatus,
        JSON.stringify(screening),
      ],
    );
    const update = mapProjectUpdateRow(insertResult.rows[0]);

    if (rules.decision === DECISION.QUARANTINE) {
      // Hard violation: auto-quarantine + alert. Subscribers are NOT notified
      // and the content is invisible on the public feed until an admin
      // reviews it in the moderation queue.
      await raiseModerationAlert({
        updateId: id,
        reason: "rule_hard_violation",
        screening,
      });
      await logAdminAction({
        actor: req.admin.sub || "admin-key",
        action: "update.auto_quarantined",
        targetType: "project_update",
        targetId: id,
        metadata: {
          reason: "rule_hard_violation",
          ruleHits: rules.ruleHits,
        },
        ipAddress: req.ip,
      });
    } else if (moderationStatus === "pending-screening") {
      // Soft signals: publish nothing until the AI screening lands. The
      // `onLive` callback is the ONLY way notifications are sent.
      screenProjectUpdate({
        updateId: id,
        onLive: (liveUpdate) => notifySubscribersForLive(project, liveUpdate),
      })
        .catch((err) => {
          console.error("[updates] Background screening failed:", err.message);
        })
        .then((outcome) => {
          if (outcome && outcome.error) {
            console.error("[updates] Background screening error:", outcome.error);
          }
        });
    } else {
      // Clean fast-path: live immediately, notify as before.
      notifySubscribersForLive(project, update);
    }

    res.status(201).json({ success: true, data: update });
  } catch (e) {
    next(e);
  }
});

// POST /api/updates/:updateId/report  (staff / admin only)
// Support agents quarantine offending updates in response to user reports.
// The report (reason + hashed caller IP) is recorded for the review queue,
// and the update moves to `quarantined` pending a moderation decision. The
// raw IP address is never stored — only its sha256 hash, per the redaction
// policy. Screenings/reports are retained per spec for the review trail.
router.post("/:updateId/report", adminRequired, async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    if (!reason || typeof reason !== "string" || !reason.trim()) {
      throw new AppError("VALIDATION_ERROR", { field: "reason" });
    }

    const updateId = req.params.updateId;
    const result = await pool.query(
      "SELECT * FROM project_updates WHERE id = $1",
      [updateId],
    );
    if (!result.rows[0]) throw new AppError("UPDATE_NOT_FOUND");

    const update = mapProjectUpdateRow(result.rows[0]);
    if (update.moderationStatus === "removed") {
      // Terminal state; nothing left to do.
      return res.status(200).json({ success: true, data: update });
    }

    const reporter = req.admin.sub || "admin-key";
    const ipHash = crypto
      .createHash("sha256")
      .update(String(req.ip || ""))
      .digest("hex");

    await pool.query(
      `INSERT INTO update_abuse_reports (id, update_id, reporter, reason, ip_hash)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (update_id, reporter)
       DO UPDATE SET reason = EXCLUDED.reason`,
      [uuidv4(), updateId, reporter, reason.trim(), ipHash],
    );

    // Already quarantined: the report is just appended to the file.
    if (update.moderationStatus === "quarantined") {
      return res.status(200).json({ success: true, data: update });
    }

    // Move live content into the quarantine pending an admin review decision.
    const screening = {
      rules: update.moderationScreening?.rules || { ruleHits: [] },
      ai: update.moderationScreening?.ai || null,
      reportedBy: { reporter, reason: reason.trim() },
    };
    const updatedResult = await pool.query(
      `UPDATE project_updates
          SET moderation_status = 'quarantined',
              moderation_screening = $2,
              moderation_reviewed_by = $3,
              moderation_reviewed_at = NOW(),
              moderation_rationale = $4
        WHERE id = $1
        RETURNING *`,
      [updateId, JSON.stringify(screening), reporter, `abuse report: ${reason.trim()}`],
    );
    const updated = mapProjectUpdateRow(updatedResult.rows[0]);

    await raiseModerationAlert({
      updateId,
      reason: "staff_abuse_report",
      screening: updated.moderationScreening,
    });
    await logAdminAction({
      actor: reporter,
      action: "update.quarantined",
      targetType: "project_update",
      targetId: updateId,
      metadata: { reason: `abuse report: ${reason.trim()}` },
      ipAddress: req.ip,
    });

    res.status(202).json({ success: true, data: updated });
  } catch (e) {
    next(e);
  }
});

// POST /api/updates/:updateId/like — toggle like (live updates only)
router.post("/:updateId/like", async (req, res, next) => {
  try {
    const { donorAddress } = req.body || {};
    if (!donorAddress || typeof donorAddress !== "string") {
      throw new AppError("VALIDATION_ERROR", { field: "donorAddress" });
    }

    const updateResult = await pool.query(
      "SELECT id FROM project_updates WHERE id = $1 AND moderation_status = 'live'",
      [req.params.updateId],
    );
    if (!updateResult.rows[0]) {
      throw new AppError("UPDATE_NOT_FOUND");
    }

    // Check if already liked
    const existing = await pool.query(
      "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
      [req.params.updateId, donorAddress],
    );

    if (existing.rows[0]) {
      // Unlike
      await pool.query(
        "DELETE FROM update_likes WHERE update_id = $1 AND donor_address = $2",
        [req.params.updateId, donorAddress],
      );
    } else {
      // Like
      await pool.query(
        "INSERT INTO update_likes (id, update_id, donor_address, created_at) VALUES ($1, $2, $3, NOW())",
        [require("uuid").v4(), req.params.updateId, donorAddress],
      );
    }

    // Get updated like count
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1",
      [req.params.updateId],
    );

    res.json({
      success: true,
      data: {
        liked: !existing.rows[0],
        likeCount: parseInt(countResult.rows[0].count),
      },
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/updates/:updateId/likes — get like count and user's like status
router.get("/:updateId/likes", async (req, res, next) => {
  try {
    const { donorAddress } = req.query;
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM update_likes WHERE update_id = $1",
      [req.params.updateId],
    );
    let liked = false;
    if (donorAddress) {
      const existing = await pool.query(
        "SELECT id FROM update_likes WHERE update_id = $1 AND donor_address = $2",
        [req.params.updateId, donorAddress],
      );
      liked = !!existing.rows[0];
    }
    res.json({
      success: true,
      data: {
        likeCount: parseInt(countResult.rows[0].count),
        liked,
      },
    });
  } catch (e) {
    next(e);
  }
});

module.exports = router;