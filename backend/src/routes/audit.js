"use strict";

/**
 * src/routes/audit.js
 *
 * Public audit-chain verification endpoints.
 *
 * The admin_audit_log table carries a tamper-evident hash chain (see
 * services/auditChain.js). These endpoints let any third party independently
 * verify the chain's integrity and fetch chain segments for offline
 * recomputation — making the log externally verifiable without requiring
 * admin credentials.
 *
 * Endpoints:
 *   GET /api/audit/verify/:table
 *     Runs verifyChain() and returns the integrity verdict.
 *
 *   GET /api/audit/chain/:table?from=X&to=Y&limit=200
 *     Returns a sorted segment of the hash chain with prev_hash and
 *     row_hash values so anyone can recompute the chain offline.
 *
 * Both endpoints are public (no authentication required — public
 * verifiability is the point) but are rate-limited via the per-endpoint
 * Redis limiter configured in middleware/rateLimitConfig.js.
 */

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const logger = require("../logger");
const { verifyChain } = require("../services/auditChain");
const { AppError } = require("../errors");

/**
 * Tables that expose a hash chain for public verification.
 * Adding a table to this set requires that:
 *   1. The table has `prev_hash` and `row_hash` columns.
 *   2. verifyChain() or an equivalent validator exists.
 */
const AUDITABLE_TABLES = new Set(["admin_audit_log"]);

// Column sets returned by the chain endpoint.  MUST include prev_hash and
// row_hash.  All other columns are the canonical fields used in
// computeRowHash() (see auditChain.canonicalize), ordered here as they
// appear in the canonicalization to make offline recomputation
// straightforward.
//
// ip_address is intentionally NOT included here: this is a public endpoint
// with no authentication, and exposing admin/operator source IPs is a
// security leak.  ip_address IS part of the computed row_hash, so offline
// recomputation of individual row hashes is not possible from the public
// payload — but chain-link integrity (prev_hash of row N == row_hash of
// row N-1) can still be verified independently.  The /verify/:table
// endpoint runs server-side with full data and returns the authoritative
// verdict.
const CHAIN_COLUMNS = [
  "id",
  "actor",
  "action",
  "target_type",
  "target_id",
  "metadata",
  "created_at",
  "prev_hash",
  "row_hash",
];

// Fields present in the canonical hash input (auditChain.canonicalize) but
// intentionally excluded from the public response.  Declared in the
// response payload so auditors know what they can and cannot recompute.
const REDACTED_FIELDS = ["ip_address"];

// ── Cursor encoding (tuple-based keyset pagination) ────────────────────
//
// Cursors encode a (created_at, id) tuple as base64 JSON so the client can
// resume pagination from the exact row boundary, even when `id` is a
// non-monotonic UUID.  "created_at ASC, id ASC" is the deterministic
// ordering used by verifyChain() and every query in this router.

/**
 * Encode a DB row into a safe opaque cursor string.
 * @param {{ created_at: string, id: string }} row
 * @returns {string} base64-encoded JSON
 */
function encodeCursor(row) {
  if (!row || !row.created_at || !row.id) return null;
  return Buffer.from(
    JSON.stringify({ created_at: row.created_at, id: row.id }),
  ).toString("base64");
}

/**
 * Decode an opaque cursor back to { created_at, id }, or null on failure.
 * @param {string|null|undefined} raw
 * @returns {{ created_at: string, id: string }|null}
 */
function parseCursor(raw) {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    if (
      typeof decoded.created_at === "string" &&
      decoded.created_at.length > 0 &&
      typeof decoded.id === "string" &&
      decoded.id.length > 0
    ) {
      return { created_at: decoded.created_at, id: decoded.id };
    }
    return null;
  } catch {
    return null;
  }
}

function validateTable(table) {
  if (!table || !AUDITABLE_TABLES.has(table)) {
    throw new AppError("VALIDATION_ERROR", {
      field: "table",
      detail: `Audit chain not available for table "${table}". Supported: ${[...AUDITABLE_TABLES].join(", ")}`,
    });
  }
}

/**
 * GET /api/audit/verify/:table
 *
 * Runs the hash-chain integrity check on the requested table and returns the
 * verdict.  The response includes:
 *   - valid:       whether the chain is intact
 *   - firstInvalidId: id of the first broken row (only when !valid)
 *   - checked:     number of rows examined
 *   - anchored:    whether verification resumed from a retention anchor
 *     (true when older rows have been pruned)
 *
 * Rate-limited per middleware/rateLimitConfig.js.
 */
router.get("/verify/:table", async (req, res, next) => {
  try {
    validateTable(req.params.table);

    const result = await verifyChain(pool);

    (req.log || logger).info(
      {
        event: "audit_chain_verify_public",
        table: req.params.table,
        valid: result.valid,
        checked: result.checked,
        anchored: result.anchored,
      },
      `Public audit-chain verification for ${req.params.table}: ${result.valid ? "valid" : "INVALID"}`,
    );

    return res.json({ success: true, data: result });
  } catch (e) {
    return next(e);
  }
});

/**
 * GET /api/audit/chain/:table
 *
 * Returns a paginated segment of the hash chain for offline recomputation.
 *
 * Query parameters:
 *   from   — base64-encoded JSON cursor: {created_at, id} of the page
 *            boundary (rows AFTER this tuple are returned)
 *   to     — base64-encoded JSON cursor: {created_at, id} of the page
 *            boundary (rows up to and including this tuple are returned)
 *   limit  — max rows to return (default 100, max 500)
 *
 * Rows are returned in chain order (oldest first) so the caller can walk
 * them in a single pass, recomputing row_hash from the preceding prev_hash.
 * Cursors use (created_at, id) tuples (keyset pagination) because `id` is a
 * non-monotonic UUID — ordering by `created_at ASC, id ASC` requires the
 * full tuple for stable boundaries.
 *
 * The result includes:
 *   - rows:            array of chain rows with all canonical fields except
 *                      ip_address (redacted for security)
 *   - redacted_fields: list of fields excluded from the public response
 *   - prevCursor:      base64 cursor for the previous page (null if none)
 *   - nextCursor:      base64 cursor for the next page (null if none)
 *   - total:           a rough estimate of total chain length (for progress UX)
 *   - hasMore:         whether more rows exist beyond this page
 *
 * Rate-limited per middleware/rateLimitConfig.js.
 */
router.get("/chain/:table", async (req, res, next) => {
  try {
    validateTable(req.params.table);

    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 100, 1),
      500,
    );
    const from = parseCursor(req.query.from);
    const to = parseCursor(req.query.to);

    // Build a parameterised query with tuple-based keyset pagination.
    // All user-supplied values are passed through $N placeholders.
    const conditions = [];
    const values = [];

    if (from) {
      values.push(from.created_at, from.id);
      conditions.push(
        `(created_at, id) > ($${values.length - 1}, $${values.length})`,
      );
    }
    if (to) {
      values.push(to.created_at, to.id);
      conditions.push(
        `(created_at, id) <= ($${values.length - 1}, $${values.length})`,
      );
    }

    // Column list is drawn from a fixed constant — safe to interpolate.
    // Table name is validated against AUDITABLE_TABLES — user input never
    // reaches the SQL text without whitelist enforcement.
    const cols = CHAIN_COLUMNS.join(", ");
    /* eslint-disable sql-injection/no-sql-injection */
    let query = `SELECT ${cols} FROM ${req.params.table}`;
    if (conditions.length) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY created_at ASC, id ASC";
    values.push(limit + 1);
    query += ` LIMIT $${values.length}`;

    const [chainResult, countResult] = await Promise.all([
      pool.query(query, values),
      pool.query(`SELECT COUNT(*)::bigint AS total FROM ${req.params.table}`),
    ]);
    /* eslint-enable sql-injection/no-sql-injection */

    const rows = chainResult.rows;
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    (req.log || logger).info(
      {
        event: "audit_chain_fetch_public",
        table: req.params.table,
        rowCount: page.length,
        fromCursor: req.query.from || null,
        toCursor: req.query.to || null,
        hasMore,
      },
      `Public audit-chain segment fetched for ${req.params.table}: ${page.length} rows`,
    );

    return res.json({
      success: true,
      data: {
        rows: page,
        redactedFields: REDACTED_FIELDS,
        prevCursor:
          page.length > 0 ? encodeCursor(page[0]) : null,
        nextCursor:
          hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]) : null,
        total: Number(countResult.rows[0]?.total || 0),
        hasMore,
      },
    });
  } catch (e) {
    return next(e);
  }
});

module.exports = router;