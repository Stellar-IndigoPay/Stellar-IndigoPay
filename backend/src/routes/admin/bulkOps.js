"use strict";

/**
 * src/routes/admin/bulkOps.js
 *
 * Admin bulk-operation ledger (#934). Every bulk admin action goes through
 * preview -> confirm (or cancel), tracked in `bulk_ops` (see
 * services/bulkOps.js for the full lifecycle and drift/outcome semantics).
 *
 * Mounted at /api/admin/bulk-ops (see routes/admin.js):
 *   POST /:type/preview  — dry-run: computes scope, counts, sample. No writes.
 *   POST /:id/confirm    — executes the previewed scope; records per-row outcomes.
 *   POST /:id/cancel     — expires a preview that was never confirmed.
 *   GET  /                — review: list recent ops with outcomes.
 *   GET  /:id             — one op's full detail, including per-row outcomes.
 */

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const { sendAppError } = require("../../errors");
const {
  registerOpType,
  createPreview,
  getOp,
  confirmOp,
  cancelOp,
  listOps,
} = require("../../services/bulkOps");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_STATUSES = ["active", "completed", "paused", "inactive"];
const VALID_CATEGORIES = [
  "Reforestation", "Solar Energy", "Ocean Conservation", "Clean Water",
  "Wildlife Protection", "Carbon Capture", "Wind Energy",
  "Sustainable Agriculture", "Other",
];

/**
 * Reference bulk-op type: deactivate every non-deactivated project matching
 * a filter (status and/or category). Represents the "batch status changes"
 * bulk operation called out in #934 — a destructive, filter-based scope
 * that can genuinely drift between preview and confirm.
 */
registerOpType("project_bulk_deactivate", {
  destructive: true,

  validateParams(params) {
    const { filter, reason } = params || {};
    if (!filter || typeof filter !== "object") {
      return "filter is required";
    }
    if (filter.status === undefined && filter.category === undefined) {
      return "filter must include status and/or category — an unscoped deactivation is not allowed";
    }
    if (filter.status !== undefined && !VALID_STATUSES.includes(filter.status)) {
      return `filter.status must be one of: ${VALID_STATUSES.join(", ")}`;
    }
    if (filter.category !== undefined && !VALID_CATEGORIES.includes(filter.category)) {
      return `filter.category must be one of: ${VALID_CATEGORIES.join(", ")}`;
    }
    if (typeof reason !== "string" || !reason.trim()) {
      return "reason is required";
    }
    return null;
  },

  async buildScope(params, client) {
    const { filter } = params;
    const where = ["deactivated_at IS NULL"];
    const values = [];
    if (filter.status !== undefined) {
      values.push(filter.status);
      where.push(`status = $${values.length}`);
    }
    if (filter.category !== undefined) {
      values.push(filter.category);
      where.push(`category = $${values.length}`);
    }
    const result = await client.query(
      `SELECT id, name, status FROM projects WHERE ${where.join(" AND ")} ORDER BY id`,
      values,
    );
    return {
      filters: filter,
      scopeIds: result.rows.map((r) => r.id),
      sample: result.rows.map((r) => ({ id: r.id, name: r.name, status: r.status })),
    };
  },

  async executeRow(id, params, client) {
    const result = await client.query(
      `UPDATE projects
         SET status = 'inactive', deactivated_at = NOW(), deactivated_by = $2, updated_at = NOW()
       WHERE id = $1 AND deactivated_at IS NULL
       RETURNING id`,
      [id, "bulk_op"],
    );
    if (result.rows.length === 0) {
      return { outcome: "skipped", reason: "already_deactivated" };
    }
    return { outcome: "changed" };
  },
});

function actorFor(req) {
  return req.admin?.sub || "admin";
}

router.use(adminRequired);

// GET /api/admin/bulk-ops?status=&type=&page=&pageSize=
router.get("/", async (req, res, next) => {
  try {
    const { status, type, page, pageSize } = req.query;
    const ops = await listOps({ status, type, page, pageSize });
    res.json({ success: true, data: ops });
  } catch (error) {
    next(error);
  }
});

// GET /api/admin/bulk-ops/:id
router.get("/:id", async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return sendAppError(res, "VALIDATION_ERROR", { field: "id" });
  }
  try {
    const op = await getOp(req.params.id);
    if (!op) return sendAppError(res, "NOT_FOUND", { reason: "Bulk operation not found" });
    res.json({ success: true, data: op });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/bulk-ops/:type/preview
router.post("/:type/preview", async (req, res, next) => {
  try {
    const op = await createPreview({
      type: req.params.type,
      params: req.body || {},
      actor: actorFor(req),
      ip: req.ip,
    });
    res.status(201).json({ success: true, data: op });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/bulk-ops/:id/confirm
// Body: { params: <same params object sent to preview>, confirm?: true }
router.post("/:id/confirm", async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return sendAppError(res, "VALIDATION_ERROR", { field: "id" });
  }
  try {
    const { params, confirm } = req.body || {};
    const op = await confirmOp({
      id: req.params.id,
      params: params || {},
      confirm,
      actor: actorFor(req),
      ip: req.ip,
    });
    const httpStatus = op.status === "partial" || op.status === "failed" ? 207 : 200;
    res.status(httpStatus).json({ success: op.status === "completed", data: op });
  } catch (error) {
    next(error);
  }
});

// POST /api/admin/bulk-ops/:id/cancel
router.post("/:id/cancel", async (req, res, next) => {
  if (!UUID_PATTERN.test(req.params.id)) {
    return sendAppError(res, "VALIDATION_ERROR", { field: "id" });
  }
  try {
    const op = await cancelOp({ id: req.params.id, actor: actorFor(req), ip: req.ip });
    res.json({ success: true, data: op });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
