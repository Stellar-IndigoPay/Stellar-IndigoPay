"use strict";

/**
 * src/routes/admin/audit-export.js
 *
 * CSV / JSON exports of the admin audit log.
 *
 * Mounted under `/api/admin/audit-log` (see routes/admin.js):
 *   - GET /api/admin/audit-log/export/csv   -> text/csv stream
 *   - GET /api/admin/audit-log/export/json  -> JSON array
 *
 * Both honor the same filter set as the paginated audit-log endpoint:
 *   actor, action, dateFrom, dateTo, targetType, targetId, ipAddress,
 *   metadataKey + metadataValue (JSONB path match).
 *
 * Heavily rate-limited (1 request / 5 minutes / admin) to protect the
 * streaming endpoints. We use an in-memory sliding window keyed by the
 * resolved admin principal so exports can't be abused to scan the log.
 */

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");

// All SQL below is built from fixed SQL fragments with $N placeholders;
// every user-supplied value is passed via the parameterized `values` array
// to pool.query(). No raw user input is concatenated into the SQL text, so
// the sql-injection rule's string-concatenation heuristic is a false positive.
/* eslint-disable sql-injection/no-sql-injection */

const EXPORT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const EXPORT_MAX_PER_WINDOW = 1;

// In-memory sliding-window store: adminKey -> number[] of timestamps.
// Process-local only; sufficient for a single-instance backstop. For a
// horizontally-scaled deploy, swap to the Redis sliding window in
// middleware/rateLimiter.js (slidingWindowRateLimit) — left as in-memory to
// avoid a hard dependency on Redis for this endpoint.
const exportBuckets = new Map();

function checkExportRateLimit(adminKey) {
  const now = Date.now();
  const windowStart = now - EXPORT_WINDOW_MS;
  const hits = (exportBuckets.get(adminKey) || []).filter(
    (t) => t > windowStart,
  );
  if (hits.length >= EXPORT_MAX_PER_WINDOW) {
    const reset = Math.ceil((hits[0] + EXPORT_WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfterSeconds: reset };
  }
  hits.push(now);
  exportBuckets.set(adminKey, hits);
  return { allowed: true };
}

/**
 * Build a parameterized WHERE clause + values for the audit-log filters.
 *
 * @param {Object} query - Express req.query
 * @param {number} [baseIndex=0] - starting $N index for the first value
 * @returns {{ where: string[], values: any[] }}
 */
function buildAuditFilters(query, baseIndex = 0) {
  const where = [];
  const values = [];
  let idx = baseIndex;

  const push = (clause, value) => {
    idx += 1;
    values.push(value);
    where.push(clause.replace(/\$N/, `$${idx}`));
  };

  if (query.actor && typeof query.actor === "string") {
    push("actor = $N", query.actor);
  }
  if (query.action && typeof query.action === "string") {
    push("action = $N", query.action);
  }
  if (query.targetType && typeof query.targetType === "string") {
    push("target_type = $N", query.targetType);
  }
  if (query.targetId && typeof query.targetId === "string") {
    push("target_id = $N", query.targetId);
  }
  if (query.ipAddress && typeof query.ipAddress === "string") {
    push("ip_address = $N", query.ipAddress);
  }
  if (query.dateFrom && typeof query.dateFrom === "string") {
    push("created_at >= $N", query.dateFrom);
  }
  if (query.dateTo && typeof query.dateTo === "string") {
    push("created_at <= $N", query.dateTo);
  }
  if (
    query.metadataKey &&
    typeof query.metadataKey === "string" &&
    query.metadataValue !== undefined
  ) {
    // JSONB path match: metadata ->> 'key' = value
    idx += 1;
    values.push(query.metadataKey);
    where.push(`metadata ->> $${idx} = $${idx + 1}`);
    idx += 1;
    values.push(String(query.metadataValue));
  }

  return { where, values };
}

function renderCsv(rows) {
  const columns = [
    "id",
    "actor",
    "action",
    "target_type",
    "target_id",
    "metadata",
    "ip_address",
    "created_at",
  ];
  const escape = (v) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return `"${s.replace(/"/g, "\"\"")}"`;
  };
  const header = columns.join(",");
  const body = rows
    .map((r) =>
      columns
        // `columns` is a fixed literal list, not user input
        // eslint-disable-next-line security/detect-object-injection
        .map((c) => escape(c === "metadata" ? r.metadata : r[c]))
        .join(","),
    )
    .join("\n");
  return `${header}\n${body}\n`;
}

router.get("/export/csv", adminRequired, async (req, res, next) => {
  try {
    const adminKey = req.admin?.sub || req.admin?.authMethod || "unknown";
    const limiter = checkExportRateLimit(adminKey);
    if (!limiter.allowed) {
      res.set("Retry-After", String(limiter.retryAfterSeconds));
      return res.status(429).json({
        error: "Export rate limit exceeded — 1 export per 5 minutes per admin.",
        retryAfter: limiter.retryAfterSeconds,
      });
    }

    const { where, values } = buildAuditFilters(req.query);
    const query =
      "SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at FROM admin_audit_log" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY created_at DESC";

    const result = await pool.query(query, values);
    const csv = renderCsv(result.rows);

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=\"audit-log-export.csv\"",
    );
    return res.status(200).send(csv);
  } catch (err) {
    return next(err);
  }
});

router.get("/export/json", adminRequired, async (req, res, next) => {
  try {
    const adminKey = req.admin?.sub || req.admin?.authMethod || "unknown";
    const limiter = checkExportRateLimit(adminKey);
    if (!limiter.allowed) {
      res.set("Retry-After", String(limiter.retryAfterSeconds));
      return res.status(429).json({
        error: "Export rate limit exceeded — 1 export per 5 minutes per admin.",
        retryAfter: limiter.retryAfterSeconds,
      });
    }

    const { where, values } = buildAuditFilters(req.query);
    const query =
      "SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at FROM admin_audit_log" +
      (where.length ? " WHERE " + where.join(" AND ") : "") +
      " ORDER BY created_at DESC";

    const result = await pool.query(query, values);
    return res.status(200).json({
      success: true,
      count: result.rows.length,
      data: result.rows,
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.buildAuditFilters = buildAuditFilters;

// Test-only helper: clear the in-memory rate-limit buckets so each test
// starts from a clean slate. Not used in production code paths.
module.exports.__resetExportBuckets = () => exportBuckets.clear();
