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
 * 
 *  CSV export streaming
 * ---------------------
 * The CSV export no longer materializes the full filtered result set (or
 * the full CSV string) in memory. It walks the table in fixed-size batches
 * using keyset ("cursor") pagination on (created_at, id) — NOT OFFSET,
 * which degrades as the export gets deeper into a large table — and
 * writes each batch to the response as it's fetched. This keeps memory
 * bounded to one batch regardless of how many rows match the filter, lets
 * the browser start downloading immediately, and keeps each individual
 * query comfortably under the pool's statement_timeout instead of running
 * one unbounded query against the whole filtered set.
 */

const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const logger = require("../../logger");
const { adminRequired } = require("../../middleware/auth");
const { sendAppError } = require("../../errors");

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


const DEFAULT_EXPORT_BATCH_SIZE = 1000;
const MAX_EXPORT_BATCH_SIZE = 5000;

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
 
const CSV_COLUMNS = [
  "id",
  "actor",
  "action",
  "target_type",
  "target_id",
  "metadata",
  "ip_address",
  "created_at",
];
 
function csvEscape(v) {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return `"${s.replace(/"/g, "\"\"")}"`;
}
 
const CSV_HEADER_LINE = CSV_COLUMNS.join(",") + "\n";
 
function csvRowLine(row) {
  return (
    CSV_COLUMNS
      // `CSV_COLUMNS` is a fixed literal list, not user input
      // eslint-disable-next-line security/detect-object-injection
      .map((c) => csvEscape(row[c]))
      .join(",") + "\n"
  );
}
 
function resolveExportBatchSize() {
  const parsed = Number.parseInt(process.env.AUDIT_EXPORT_BATCH_SIZE, 10);
  const size = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_EXPORT_BATCH_SIZE;
  return Math.min(size, MAX_EXPORT_BATCH_SIZE);
}
 
/**
 * Build the SQL + values for one batch of a keyset-paginated audit-log
 * export.
 *
 * @param {string[]} baseWhere - WHERE fragments from buildAuditFilters
 * @param {any[]} baseValues - values matching baseWhere, in $N order
 * @param {{createdAt: string, id: string} | null} cursor - last row of the
 *   previous batch (null for the first batch)
 * @param {number} batchSize - max rows to fetch in this batch
 * @returns {{ query: string, values: any[] }}
 */
function buildBatchQuery(baseWhere, baseValues, cursor, batchSize) {
  const where = [...baseWhere];
  const values = [...baseValues];
 
  if (cursor) {
    values.push(cursor.createdAt, cursor.id);
    const createdAtIdx = values.length - 1;
    const idIdx = values.length;
    // Row-comparison keyset predicate: strictly older than the last row we
    // already streamed. Using (created_at, id) rather than created_at alone
    // keeps pagination correct even when many rows share a created_at.
    where.push(`(created_at, id) < ($${createdAtIdx}, $${idIdx})`);
  }
 
  values.push(batchSize);
  const limitIdx = values.length;
 
  let query =
    "SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at FROM admin_audit_log";
  if (where.length) {
    query += " WHERE " + where.join(" AND ");
  }
  query += ` ORDER BY created_at DESC, id DESC LIMIT $${limitIdx}`;
 
  return { query, values };
}
 
/**
 * Async generator that walks the filtered audit log in fixed-size batches
 * using keyset pagination, yielding one array of rows per batch. Never
 * holds more than one batch in memory.
 */
async function* fetchAuditLogBatches({ where, values, batchSize }) {
  let cursor = null;
 
  for (;;) {
    const batch = buildBatchQuery(where, values, cursor, batchSize);
    // eslint-disable-next-line no-await-in-loop
    const result = await pool.query(batch.query, batch.values);
 
    if (result.rows.length === 0) return;
 
    yield result.rows;
 
    if (result.rows.length < batchSize) return;
 
    const last = result.rows[result.rows.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
}
 
router.get("/export/csv", adminRequired, async (req, res, next) => {
  const adminKey = req.admin?.sub || req.admin?.authMethod || "unknown";
  const limiter = checkExportRateLimit(adminKey);
  if (!limiter.allowed) {
    res.set("Retry-After", String(limiter.retryAfterSeconds));
    return sendAppError(res, "RATE_LIMITED", {
      detail: "Export rate limit exceeded — 1 export per 5 minutes per admin.",
      retryAfter: limiter.retryAfterSeconds,
    });
  }
 
  const { where, values } = buildAuditFilters(req.query);
  const batchSize = resolveExportBatchSize();
 
  // If the client goes away mid-export, stop pulling further batches from
  // Postgres instead of streaming into the void.
  let clientAborted = false;
  req.on("close", () => {
    clientAborted = true;
  });
 
  try {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=\"audit-log-export.csv\"",
    );
 
    res.write(CSV_HEADER_LINE);
 
    for await (const rows of fetchAuditLogBatches({ where, values, batchSize })) {
      if (clientAborted) break;
 
      const chunk = rows.map(csvRowLine).join("");
      const canWriteMore = res.write(chunk);
 
      if (!canWriteMore) {
        // Respect backpressure: don't pull the next batch from Postgres
        // until the client has drained what we've already written.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => res.once("drain", resolve));
      }
    }
 
    return res.end();
  } catch (err) {
    if (res.headersSent) {
      // We're mid-stream; a normal JSON error response is no longer
      // possible. Log and terminate the connection rather than trying to
      // send a second response.
      logger.error(
        { event: "audit_export_stream_error", err: err.message },
        "Audit CSV export failed mid-stream",
      );
      return res.end();
    }
    return next(err);
  }
});
 
router.get("/export/json", adminRequired, async (req, res, next) => {
  try {
    const adminKey = req.admin?.sub || req.admin?.authMethod || "unknown";
    const limiter = checkExportRateLimit(adminKey);
    if (!limiter.allowed) {
      res.set("Retry-After", String(limiter.retryAfterSeconds));
      return sendAppError(res, "RATE_LIMITED", {
        detail: "Export rate limit exceeded — 1 export per 5 minutes per admin.",
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