"use strict";

/**
 * src/routes/admin/aiPromptVersions.js
 *
 * Admin management of AI summary prompt template versions (issue #929).
 *
 * Regeneration is always a deliberate, audited admin action: bumping the
 * active prompt template version here changes the cache key every summary
 * generation computes going forward (see services/claude.js), so existing
 * cached summaries stay untouched (audit trail preserved) while every
 * subsequent generate-summary call naturally misses the cache and produces
 * fresh output under the new template. Nothing in this codebase bumps the
 * version automatically.
 */

const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { sendAppError } = require("../../errors");

// GET /api/admin/ai-prompt-versions — list every version, newest first.
router.get("/", adminRequired, async (req, res, next) => {
  try {
    const result = await pool.query(
      `SELECT id, slug, model, active, created_by, created_at, activated_at
         FROM prompt_versions
        ORDER BY created_at DESC`,
    );
    res.json({ success: true, data: result.rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/admin/ai-prompt-versions
// Body: { slug: string, body: string, model: string }
// Creates a new version and deliberately activates it (deactivating any
// currently-active row) in one transaction.
router.post("/", adminRequired, async (req, res, next) => {
  const { slug, body, model } = req.body || {};

  if (!slug || typeof slug !== "string") {
    return sendAppError(res, "VALIDATION_ERROR", { field: "slug" });
  }
  if (!body || typeof body !== "string") {
    return sendAppError(res, "VALIDATION_ERROR", { field: "body" });
  }
  if (!model || typeof model !== "string") {
    return sendAppError(res, "VALIDATION_ERROR", { field: "model" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE prompt_versions SET active = FALSE WHERE active = TRUE");

    const id = uuid();
    const actor = (req.admin && req.admin.sub) || "admin";
    const inserted = await client.query(
      `INSERT INTO prompt_versions (id, slug, body, model, active, created_by, activated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, NOW())
       RETURNING id, slug, model, active, created_by, created_at, activated_at`,
      [id, slug, body, model, actor],
    );
    await client.query("COMMIT");

    logAdminAction({
      actor,
      action: "ai_prompt_version.activated",
      targetType: "prompt_version",
      targetId: id,
      metadata: { slug, model },
      ipAddress: req.ip,
    });

    res.status(201).json({ success: true, data: inserted.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      return sendAppError(res, "VALIDATION_ERROR", {
        field: "slug",
        detail: "A prompt version with this slug already exists",
      });
    }
    next(err);
  } finally {
    client.release();
  }
});

module.exports = router;
