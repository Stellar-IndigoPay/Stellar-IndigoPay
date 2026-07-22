"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const redis = require("../../services/redis");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { mapProjectRow } = require("../../services/store");

const PROJECTS_LIST_CACHE_PREFIX = "projects:list:";
const VALID_STATUSES = ["active", "completed", "paused", "inactive"];
const VALID_CATEGORIES = [
  "Reforestation", "Solar Energy", "Ocean Conservation", "Clean Water",
  "Wildlife Protection", "Carbon Capture", "Wind Energy",
  "Sustainable Agriculture", "Other",
];
const EDITABLE_FIELDS = {
  name: "name",
  description: "description",
  category: "category",
  location: "location",
  goalXLM: "goal_xlm",
  tags: "tags",
  co2OffsetKg: "co2_offset_kg",
};

router.use(adminRequired);

function mapAdminProject(row) {
  return {
    ...mapProjectRow(row),
    deactivatedAt: row.deactivated_at
      ? new Date(row.deactivated_at).toISOString()
      : null,
    deactivatedBy: row.deactivated_by || null,
  };
}

function actorFor(req) {
  return req.admin?.sub || "admin";
}

function ipFor(req) {
  return req.ip;
}

function validStatus(value) {
  return typeof value === "string" && VALID_STATUSES.includes(value);
}

function validatePatch(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "A JSON object is required";
  }
  const fields = Object.keys(body).filter((key) => key in EDITABLE_FIELDS || key === "status");
  if (!fields.length) return "Provide at least one editable project field";
  if (fields.length !== Object.keys(body).length) return "One or more fields cannot be updated";
  if (body.status !== undefined && !validStatus(body.status)) {
    return `status must be one of: ${VALID_STATUSES.join(", ")}`;
  }
  if (body.category !== undefined && !VALID_CATEGORIES.includes(body.category)) {
    return `category must be one of: ${VALID_CATEGORIES.join(", ")}`;
  }
  if (body.co2OffsetKg !== undefined && (!Number.isInteger(body.co2OffsetKg) || body.co2OffsetKg < 0)) {
    return "co2OffsetKg must be a non-negative integer";
  }
  if (body.goalXLM !== undefined && (!Number.isFinite(Number(body.goalXLM)) || Number(body.goalXLM) < 0)) {
    return "goalXLM must be a non-negative number";
  }
  if (body.tags !== undefined && (!Array.isArray(body.tags) || !body.tags.every((tag) => typeof tag === "string"))) {
    return "tags must be an array of strings";
  }
  for (const field of ["name", "description", "location"]) {
    if (body[field] !== undefined && (typeof body[field] !== "string" || !body[field].trim())) {
      return `${field} must be a non-empty string`;
    }
  }
  return null;
}

async function clearProjectCache() {
  await redis.deletePattern(PROJECTS_LIST_CACHE_PREFIX + "*");
}

/** GET /api/admin/projects?search=&status=&category=&includeDeactivated=&page=&pageSize= */
router.get("/", async (req, res, next) => {
  try {
    const { search, status, category, includeDeactivated } = req.query;
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 50, 1), 200);
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const where = [];
    const values = [];

    if (status && validStatus(status)) {
      values.push(status);
      where.push(`status = $${values.length}`);
    }
    if (category && VALID_CATEGORIES.includes(category)) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }
    if (includeDeactivated !== "true") where.push("deactivated_at IS NULL");
    if (search && typeof search === "string") {
      values.push(`%${search}%`);
      where.push(`(name ILIKE $${values.length} OR description ILIKE $${values.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countValues = [...values];
    const count = await pool.query(`SELECT COUNT(*)::int AS total FROM projects ${whereSql}`, countValues);
    const pageValues = [...values, pageSize, (page - 1) * pageSize];
    const result = await pool.query(
      `SELECT * FROM projects ${whereSql} ORDER BY created_at DESC, id DESC LIMIT $${pageValues.length - 1} OFFSET $${pageValues.length}`,
      pageValues,
    );
    res.json({ success: true, data: result.rows.map(mapAdminProject), total: count.rows[0].total, page, pageSize });
  } catch (error) {
    next(error);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM projects WHERE id = $1", [req.params.id]);
    if (!result.rows[0]) return res.status(404).json({ error: "Project not found" });
    return res.json({ success: true, data: mapAdminProject(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

/** PATCH /api/admin/projects/:id updates administrative project fields. */
router.patch("/:id", async (req, res, next) => {
  const validationError = validatePatch(req.body);
  if (validationError) return res.status(400).json({ error: validationError });
  try {
    const actor = actorFor(req);
    const values = [];
    const updates = [];
    for (const [field, column] of Object.entries(EDITABLE_FIELDS)) {
      if (req.body[field] === undefined) continue;
      values.push(typeof req.body[field] === "string" ? req.body[field].trim() : req.body[field]);
      updates.push(`${column} = $${values.length}`);
    }
    if (req.body.status !== undefined) {
      values.push(req.body.status);
      updates.push(`status = $${values.length}`);
      if (req.body.status === "inactive") {
        values.push(actor);
        updates.push("deactivated_at = NOW()", `deactivated_by = $${values.length}`);
      } else {
        updates.push("deactivated_at = NULL", "deactivated_by = NULL");
      }
    }
    updates.push("updated_at = NOW()");
    values.push(req.params.id);
    const result = await pool.query(
      `UPDATE projects SET ${updates.join(", ")} WHERE id = $${values.length} RETURNING *`, values,
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Project not found" });
    await clearProjectCache();
    await logAdminAction({ actor, action: "project.update", targetType: "project", targetId: req.params.id, metadata: { changes: req.body }, ipAddress: ipFor(req) });
    return res.json({ success: true, data: mapAdminProject(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

/** DELETE is intentionally a soft delete: it deactivates, never removes, the row. */
router.delete("/:id", async (req, res, next) => {
  try {
    const actor = actorFor(req);
    const result = await pool.query(
      "UPDATE projects SET status = 'inactive', deactivated_at = NOW(), deactivated_by = $1, updated_at = NOW() WHERE id = $2 RETURNING *",
      [actor, req.params.id],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "Project not found" });
    await clearProjectCache();
    await logAdminAction({ actor, action: "project.deactivate", targetType: "project", targetId: req.params.id, metadata: {}, ipAddress: ipFor(req) });
    return res.json({ success: true, data: mapAdminProject(result.rows[0]) });
  } catch (error) {
    next(error);
  }
});

/**
 * POST /api/admin/projects/batch
 * Body: { projectIds: string[], status?: string, co2OffsetKg?: number }
 */
router.post("/batch", async (req, res, next) => {
  const { projectIds, status, co2OffsetKg } = req.body || {};
  if (!Array.isArray(projectIds) || !projectIds.length || projectIds.length > 500 || !projectIds.every((id) => typeof id === "string" && id)) {
    return res.status(400).json({ error: "projectIds must be an array of 1 to 500 project IDs" });
  }
  if (status === undefined && co2OffsetKg === undefined) return res.status(400).json({ error: "Provide status and/or co2OffsetKg" });
  if (status !== undefined && !validStatus(status)) return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` });
  if (co2OffsetKg !== undefined && (!Number.isInteger(co2OffsetKg) || co2OffsetKg < 0)) return res.status(400).json({ error: "co2OffsetKg must be a non-negative integer" });

  const client = await pool.connect();
  try {
    const actor = actorFor(req);
    const uniqueIds = [...new Set(projectIds)];
    await client.query("BEGIN");
    const values = [];
    const updates = [];
    if (status !== undefined) {
      values.push(status);
      updates.push(`status = $${values.length}`);
      if (status === "inactive") {
        values.push(actor);
        updates.push("deactivated_at = NOW()", `deactivated_by = $${values.length}`);
      } else {
        updates.push("deactivated_at = NULL", "deactivated_by = NULL");
      }
    }
    if (co2OffsetKg !== undefined) {
      values.push(co2OffsetKg);
      updates.push(`co2_offset_kg = $${values.length}`);
    }
    updates.push("updated_at = NOW()");
    values.push(uniqueIds);
    const result = await client.query(
      `UPDATE projects SET ${updates.join(", ")} WHERE id = ANY($${values.length}::uuid[]) RETURNING *`, values,
    );
    if (result.rows.length !== uniqueIds.length) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "One or more projects were not found" });
    }
    await client.query("COMMIT");
    await clearProjectCache();
    await logAdminAction({ actor, action: "project.batch_update", targetType: "project", targetId: null, metadata: { projectIds: uniqueIds, status, co2OffsetKg }, ipAddress: ipFor(req) });
    return res.json({ success: true, count: result.rows.length, data: result.rows.map(mapAdminProject) });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally {
    client.release();
  }
});

module.exports = router;
