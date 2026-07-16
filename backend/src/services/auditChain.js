"use strict";

/**
 * src/services/auditChain.js
 *
 * Tamper-evident hash-chain helpers for the admin audit log.
 *
 * Each row in `admin_audit_log` carries:
 *   - prev_hash: SHA-256 of the *previous* row's row_hash (or '0' for genesis)
 *   - row_hash:  SHA-256 over the row's own canonical fields + prev_hash
 *
 * This makes the log an append-only chain: altering any historical row
 * changes its row_hash, which then invalidates the prev_hash of every row
 * that follows it. `verifyChain` walks the chain oldest -> newest and finds
 * the first broken link.
 *
 * Hashing uses Node's built-in `crypto` (no external dep). The canonical
 * string is a pipe-delimited concatenation of field values; `null`/`undefined`
 * are normalized to the empty string so the hash is deterministic across
 * drivers that return null vs undefined.
 */

const crypto = require("crypto");

const GENESIS_PREV_HASH = "0";

/**
 * Deterministically serialize a set of fields into the canonical hash input.
 * Order matters and MUST remain stable across releases.
 *
 * @param {Object} fields
 * @returns {string}
 */
function canonicalize(fields) {
  const parts = [
    fields.id,
    fields.actor,
    fields.action,
    fields.targetType,
    fields.targetId,
    fields.metadata,
    fields.ipAddress,
    fields.created_at,
    fields.prev_hash,
  ];
  return parts
    .map((v) => (v === null || v === undefined ? "" : String(v)))
    .join("|");
}

/**
 * Compute the SHA-256 row hash for a single audit entry.
 *
 * @param {Object} row
 * @param {string} [row.id]
 * @param {string} [row.actor]
 * @param {string} [row.action]
 * @param {string|null} [row.targetType]
 * @param {string|null} [row.targetId]
 * @param {string|Object} [row.metadata]  - stored as JSON string or object
 * @param {string|null} [row.ipAddress]
 * @param {string|Date} [row.created_at]
 * @param {string} [row.prev_hash]
 * @returns {string} hex SHA-256
 */
function computeRowHash(row) {
  const metadata =
    row.metadata && typeof row.metadata === "object"
      ? JSON.stringify(row.metadata)
      : row.metadata;

  const createdAt =
    row.created_at instanceof Date
      ? row.created_at.toISOString()
      : row.created_at;

  return crypto
    .createHash("sha256")
    .update(
      canonicalize({
        id: row.id,
        actor: row.actor,
        action: row.action,
        targetType: row.targetType,
        targetId: row.targetId,
        metadata,
        ipAddress: row.ipAddress,
        created_at: createdAt,
        prev_hash: row.prev_hash || GENESIS_PREV_HASH,
      }),
    )
    .digest("hex");
}

/**
 * Return the row_hash of the most recent audit entry, or '0' if the log is
 * empty. Used as the prev_hash for the next inserted row.
 *
 * @param {Object} client - pg client / pool with a `.query()` method
 * @returns {Promise<string>}
 */
async function getPrevHash(client) {
  const result = await client.query(
    "SELECT row_hash FROM admin_audit_log ORDER BY created_at DESC, id DESC LIMIT 1",
  );
  if (!result.rows.length) return GENESIS_PREV_HASH;
  return result.rows[0].row_hash || GENESIS_PREV_HASH;
}

/**
 * Verify the integrity of the entire audit chain.
 *
 * Walks rows oldest -> newest. For each row, recomputes the expected
 * row_hash from the row's own fields and the *stored* prev_hash, and checks
 * the stored row_hash matches. Also checks that each row's stored prev_hash
 * equals the previous row's actual row_hash (except the genesis row whose
 * prev_hash must be '0' or empty).
 *
 * @param {Object} client - pg client / pool with a `.query()` method
 * @returns {Promise<{valid: boolean, firstInvalidId?: string, checked?: number}>}
 */
async function verifyChain(client) {
  const result = await client.query(
    `SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at, prev_hash, row_hash
     FROM admin_audit_log
     ORDER BY created_at ASC, id ASC`,
  );

  const rows = result.rows;
  let prevRowHash = GENESIS_PREV_HASH;

  for (const row of rows) {
    // 1. The stored prev_hash must point at the previous row's actual hash.
    const expectedPrevHash = prevRowHash;
    if ((row.prev_hash || GENESIS_PREV_HASH) !== expectedPrevHash) {
      return { valid: false, firstInvalidId: row.id, checked: rows.length };
    }

    // 2. The stored row_hash must equal a recomputation from the row's fields.
    const computed = computeRowHash({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      metadata: row.metadata,
      ipAddress: row.ip_address,
      created_at: row.created_at,
      prev_hash: row.prev_hash || GENESIS_PREV_HASH,
    });

    if (computed !== row.row_hash) {
      return { valid: false, firstInvalidId: row.id, checked: rows.length };
    }

    prevRowHash = row.row_hash;
  }

  return { valid: true, checked: rows.length };
}

module.exports = {
  GENESIS_PREV_HASH,
  computeRowHash,
  getPrevHash,
  verifyChain,
};
