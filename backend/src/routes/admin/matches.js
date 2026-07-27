/**
 * src/routes/admin/matches.js
 *
 * Admin CRUD endpoints for donation match pool management.
 * Mounted at /api/admin/matches and /api/v1/admin/matches.
 *
 * POST   /          — Create a match pool
 * GET    /          — List all pools (filterable by projectId, status)
 * GET    /:id       — Get single pool details
 * PATCH  /:id       — Update pool (capXLM, multiplier, expiresAt, status)
 * DELETE /:id       — Cancel pool (sets status = 'cancelled')
 */
"use strict";

const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { AppError } = require("../../errors");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STELLAR_ADDRESS_RE = /^G[A-Z0-9]{55}$/;
const VALID_STATUSES = new Set(["active", "expired", "exhausted", "cancelled"]);

// All admin match endpoints require authentication
router.use(adminRequired);

/**
 * Map a database row to the public-facing camelCase shape.
 */
function mapMatchRow(row) {
  const capXlm = parseFloat(row.cap_xlm || "0");
  const matchedXlm = parseFloat(row.matched_xlm || "0");
  const remainingXlm = Math.max(0, capXlm - matchedXlm);
  const progressPct = capXlm > 0 ? Math.min(100, (matchedXlm / capXlm) * 100) : 0;

  return {
    id: row.id,
    projectId: row.project_id,
    matcherAddress: row.matcher_address,
    capXLM: row.cap_xlm,
    multiplier: row.multiplier,
    matchedXLM: row.matched_xlm,
    remainingXLM: remainingXlm.toFixed(7),
    progressPct: parseFloat(progressPct.toFixed(2)),
    expiresAt: row.expires_at,
    status: row.status,
    createdAt: row.created_at,
  };
}

/**
 * POST /api/admin/matches — Create a new match pool.
 *
 * Body: { projectId, matcherAddress, capXLM, multiplier, expiresAt }
 */
router.post("/", async (req, res, next) => {
  try {
    const { projectId, matcherAddress, capXLM, multiplier = 1, expiresAt } = req.body || {};

    // Validate required fields
    if (!projectId || !UUID_RE.test(projectId)) {
      throw new AppError("VALIDATION_ERROR", { field: "projectId", message: "Valid project UUID required" });
    }
    if (!matcherAddress || !STELLAR_ADDRESS_RE.test(matcherAddress)) {
      throw new AppError("VALIDATION_ERROR", { field: "matcherAddress", message: "Valid Stellar address required" });
    }
    const parsedCap = parseFloat(capXLM);
    if (isNaN(parsedCap) || parsedCap <= 0) {
      throw new AppError("VALIDATION_ERROR", { field: "capXLM", message: "capXLM must be a positive number" });
    }
    const parsedMultiplier = parseInt(multiplier, 10);
    if (isNaN(parsedMultiplier) || parsedMultiplier < 1) {
      throw new AppError("VALIDATION_ERROR", { field: "multiplier", message: "multiplier must be an integer >= 1" });
    }
    if (!expiresAt || new Date(expiresAt).getTime() <= Date.now()) {
      throw new AppError("VALIDATION_ERROR", { field: "expiresAt", message: "expiresAt must be a future date" });
    }

    // Confirm project exists
    const projectCheck = await pool.query("SELECT id FROM projects WHERE id = $1", [projectId]);
    if (!projectCheck.rows[0]) {
      throw new AppError("PROJECT_NOT_FOUND");
    }

    const id = uuid();
    const result = await pool.query(
      `INSERT INTO donation_matches
         (id, project_id, matcher_address, cap_xlm, multiplier, expires_at, matched_xlm, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 'active', NOW())
       RETURNING *`,
      [id, projectId, matcherAddress, parsedCap, parsedMultiplier, expiresAt],
    );

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "match_pool_created",
      targetType: "donation_match",
      targetId: id,
      metadata: { projectId, capXLM: parsedCap, multiplier: parsedMultiplier },
      req,
    });

    return res.status(201).json({ success: true, data: mapMatchRow(result.rows[0]) });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/matches — List all match pools.
 *
 * Query: ?projectId=uuid&status=active|expired|exhausted|cancelled
 */
router.get("/", async (req, res, next) => {
  try {
    const { projectId, status } = req.query;

    const conditions = [];
    const values = [];

    if (projectId) {
      if (!UUID_RE.test(projectId)) {
        throw new AppError("VALIDATION_ERROR", { field: "projectId" });
      }
      values.push(projectId);
      conditions.push(`dm.project_id = $${values.length}`);
    }

    if (status) {
      if (!VALID_STATUSES.has(status)) {
        throw new AppError("VALIDATION_ERROR", { field: "status", message: `status must be one of: ${[...VALID_STATUSES].join(", ")}` });
      }
      values.push(status);
      conditions.push(`dm.status = $${values.length}`);
    }

    const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    // eslint-disable-next-line sql-injection/no-sql-injection
    const result = await pool.query(
      `SELECT dm.*,
              p.name AS project_name,
              (dm.matched_xlm / NULLIF(dm.cap_xlm, 0) * 100) AS progress_pct
         FROM donation_matches dm
         JOIN projects p ON dm.project_id = p.id
         ${whereClause}
         ORDER BY dm.created_at DESC`,
      values,
    );

    return res.json({
      success: true,
      data: result.rows.map((row) => ({
        ...mapMatchRow(row),
        projectName: row.project_name,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * GET /api/admin/matches/:id — Get a single match pool.
 */
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new AppError("VALIDATION_ERROR", { field: "id" });
    }

    const result = await pool.query(
      `SELECT dm.*, p.name AS project_name
         FROM donation_matches dm
         JOIN projects p ON dm.project_id = p.id
         WHERE dm.id = $1`,
      [id],
    );

    if (!result.rows[0]) {
      throw new AppError("NOT_FOUND", { message: "Match pool not found" });
    }

    return res.json({
      success: true,
      data: { ...mapMatchRow(result.rows[0]), projectName: result.rows[0].project_name },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * PATCH /api/admin/matches/:id — Update a match pool.
 *
 * Body: any subset of { capXLM, multiplier, expiresAt, status }
 */
router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new AppError("VALIDATION_ERROR", { field: "id" });
    }

    const existing = await pool.query("SELECT * FROM donation_matches WHERE id = $1", [id]);
    if (!existing.rows[0]) {
      throw new AppError("NOT_FOUND", { message: "Match pool not found" });
    }

    const { capXLM, multiplier, expiresAt, status } = req.body || {};
    const updates = [];
    const values = [];

    if (capXLM !== undefined) {
      const parsed = parseFloat(capXLM);
      if (isNaN(parsed) || parsed <= 0) {
        throw new AppError("VALIDATION_ERROR", { field: "capXLM" });
      }
      values.push(parsed);
      updates.push(`cap_xlm = $${values.length}`);
    }

    if (multiplier !== undefined) {
      const parsed = parseInt(multiplier, 10);
      if (isNaN(parsed) || parsed < 1) {
        throw new AppError("VALIDATION_ERROR", { field: "multiplier" });
      }
      values.push(parsed);
      updates.push(`multiplier = $${values.length}`);
    }

    if (expiresAt !== undefined) {
      if (new Date(expiresAt).getTime() <= Date.now()) {
        throw new AppError("VALIDATION_ERROR", { field: "expiresAt", message: "expiresAt must be a future date" });
      }
      values.push(expiresAt);
      updates.push(`expires_at = $${values.length}`);
    }

    if (status !== undefined) {
      if (!VALID_STATUSES.has(status)) {
        throw new AppError("VALIDATION_ERROR", { field: "status" });
      }
      values.push(status);
      updates.push(`status = $${values.length}`);
    }

    if (updates.length === 0) {
      throw new AppError("VALIDATION_ERROR", { message: "No updatable fields provided" });
    }

    values.push(id);
    // eslint-disable-next-line sql-injection/no-sql-injection
    const result = await pool.query(
      `UPDATE donation_matches SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`,
      values,
    );

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "match_pool_updated",
      targetType: "donation_match",
      targetId: id,
      metadata: req.body,
      req,
    });

    return res.json({ success: true, data: mapMatchRow(result.rows[0]) });
  } catch (e) {
    next(e);
  }
});

/**
 * DELETE /api/admin/matches/:id — Cancel a match pool.
 *
 * Sets status = 'cancelled'. Does not delete the row (preserves audit trail).
 */
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!UUID_RE.test(id)) {
      throw new AppError("VALIDATION_ERROR", { field: "id" });
    }

    const result = await pool.query(
      "UPDATE donation_matches SET status = 'cancelled' WHERE id = $1 RETURNING *",
      [id],
    );

    if (!result.rows[0]) {
      throw new AppError("NOT_FOUND", { message: "Match pool not found" });
    }

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "match_pool_cancelled",
      targetType: "donation_match",
      targetId: id,
      metadata: {},
      req,
    });

    return res.json({ success: true, data: mapMatchRow(result.rows[0]) });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
