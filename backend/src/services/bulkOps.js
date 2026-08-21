"use strict";

/**
 * src/services/bulkOps.js
 *
 * Admin bulk-operation ledger (#934).
 *
 * Every bulk admin operation goes through three steps, backed by the
 * `bulk_ops` table (migration 030):
 *
 *   1. preview  — createPreview() computes the current scope (which rows
 *      match) and stores it with a hash of the params. No writes happen.
 *   2. confirm  — confirmOp() re-validates the params hash (no tampering
 *      between steps), re-computes the scope to detect drift (rows that
 *      stopped/started matching since the preview), then executes against
 *      exactly the previewed scope in batches, recording a changed/skipped/
 *      failed outcome per row.
 *   3. cancel   — cancelOp() expires a preview that was never confirmed.
 *
 * Every step is written to the admin audit chain via logAdminAction() so
 * "what did this op change" is reconstructable from the audit log alone.
 * Audit metadata carries row *ids* and counts only — never row payloads —
 * so PII never lands in the audit trail beyond identifiers.
 *
 * Op types are registered with registerOpType() and describe how to compute
 * a scope and how to act on one row; the ledger itself (hashing, drift
 * detection, batching, outcome recording, audit, metrics) is type-agnostic.
 */

const crypto = require("crypto");
const { v4: uuid } = require("uuid");
const pool = require("../db/pool");
const { AppError } = require("../errors");
const { logAdminAction } = require("./audit");
const { bulkOpRowOutcomesTotal, bulkOpsTotal, bulkOpDurationSeconds } = require("./metrics");

const DEFAULT_TTL_MS = Number(process.env.BULK_OP_PREVIEW_TTL_MS) || 15 * 60 * 1000;
const BATCH_SIZE = Number(process.env.BULK_OP_BATCH_SIZE) || 100;
const SAMPLE_LIMIT = 5;
const DRIFT_SAMPLE_LIMIT = 20;

const opTypes = new Map();

/**
 * Register a bulk-op type.
 *
 * @param {string} name
 * @param {Object} def
 * @param {boolean} def.destructive - whether confirm requires an explicit `confirm: true` flag
 * @param {(params: Object) => string|null} def.validateParams - returns an error string, or null if valid
 * @param {(params: Object, client: Object) => Promise<{scopeIds: string[], sample: Object[]}>} def.buildScope
 * @param {(id: string, params: Object, client: Object) => Promise<{outcome: "changed"|"skipped", reason?: string}>} def.executeRow
 */
function registerOpType(name, def) {
  opTypes.set(name, def);
}

function getOpType(name) {
  return opTypes.get(name) || null;
}

function hashParams(params) {
  const canonical = JSON.stringify(params, Object.keys(params || {}).sort());
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

function actorFor(actor) {
  return actor || "admin";
}

function mapRow(row) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    filters: row.filters,
    previewCount: row.preview_count,
    sample: row.sample,
    destructive: row.destructive,
    createdBy: row.created_by,
    confirmedBy: row.confirmed_by,
    outcomes: row.outcomes,
    error: row.error,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Step 1: create a dry-run preview. Read-only — never mutates target rows.
 */
async function createPreview({ type, params, actor, ip, ttlMs }) {
  const opType = getOpType(type);
  if (!opType) {
    throw new AppError("VALIDATION_ERROR", { field: "type", detail: `Unknown bulk-op type: ${type}` });
  }
  const validationError = opType.validateParams(params || {});
  if (validationError) {
    throw new AppError("VALIDATION_ERROR", { field: "params", detail: validationError });
  }

  const { scopeIds, sample, filters } = await opType.buildScope(params, pool);
  const id = uuid();
  const paramsHash = hashParams(params);
  const expiresAt = new Date(Date.now() + (ttlMs || DEFAULT_TTL_MS));

  await pool.query(
    `INSERT INTO bulk_ops
       (id, type, params, params_hash, filters, scope_ids, preview_count, sample, destructive, status, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'preview', $10, $11)`,
    [
      id,
      type,
      JSON.stringify(params || {}),
      paramsHash,
      JSON.stringify(filters || {}),
      JSON.stringify(scopeIds),
      scopeIds.length,
      JSON.stringify(sample.slice(0, SAMPLE_LIMIT)),
      !!opType.destructive,
      actorFor(actor),
      expiresAt,
    ],
  );

  await logAdminAction({
    actor: actorFor(actor),
    action: "bulk_op.preview",
    targetType: "bulk_op",
    targetId: id,
    metadata: { type, filters, previewCount: scopeIds.length, destructive: !!opType.destructive, expiresAt },
    ipAddress: ip,
  });

  return getOp(id);
}

async function getOp(id) {
  const result = await pool.query("SELECT * FROM bulk_ops WHERE id = $1", [id]);
  if (!result.rows[0]) return null;
  return mapRow(result.rows[0]);
}

/** Lazily flip previews whose TTL has elapsed to 'expired'. */
async function expireIfStale(row) {
  if (row.status !== "preview" || new Date(row.expires_at).getTime() >= Date.now()) {
    return row;
  }
  const result = await pool.query(
    `UPDATE bulk_ops SET status = 'expired' WHERE id = $1 AND status = 'preview' RETURNING *`,
    [row.id],
  );
  return result.rows[0] || row;
}

/**
 * Step 2: confirm and execute a previewed op.
 *
 * - Re-validates `params` against the stored params_hash (no tampering
 *   between preview and confirm).
 * - Destructive op types require `confirm: true` in addition to the
 *   two-step flow itself.
 * - Re-computes the current scope to detect drift: rows that dropped out of
 *   scope are recorded as skipped (visible, not silently excluded); rows
 *   that newly match are reported in the summary but never executed
 *   (visible, not silently included) — confirm applies exactly the
 *   previewed scope.
 * - Executes in batches, each batch in its own transaction, recording a
 *   changed/skipped/failed outcome per row so a partial failure never
 *   results in a silent skip.
 */
async function confirmOp({ id, params, confirm, actor, ip }) {
  // Atomic CAS: only one confirm can move a preview to 'confirmed'. A
  // concurrent second confirm sees rowCount 0 and is rejected as CONFLICT,
  // rather than racing to execute the same scope twice.
  const claim = await pool.query(
    `UPDATE bulk_ops SET status = 'confirmed', confirmed_by = $2, started_at = NOW()
     WHERE id = $1 AND status = 'preview' AND expires_at >= NOW()
     RETURNING *`,
    [id, actorFor(actor)],
  );

  if (!claim.rows[0]) {
    const existing = await pool.query("SELECT * FROM bulk_ops WHERE id = $1", [id]);
    if (!existing.rows[0]) {
      throw new AppError("NOT_FOUND", { reason: "Bulk operation not found" });
    }
    const row = await expireIfStale(existing.rows[0]);
    if (row.status === "expired") {
      throw new AppError("CONFLICT", { reason: "Preview has expired; create a new preview" });
    }
    throw new AppError("CONFLICT", { reason: `Bulk operation is already ${row.status}` });
  }

  const op = claim.rows[0];
  const opType = getOpType(op.type);

  try {
    if (hashParams(params || {}) !== op.params_hash) {
      throw new AppError("VALIDATION_ERROR", {
        detail: "params do not match the previewed params hash; create a new preview",
      });
    }
    if (op.destructive && confirm !== true) {
      throw new AppError("VALIDATION_ERROR", {
        field: "confirm",
        detail: "This op is destructive; resend with confirm: true to execute it",
      });
    }

    const previewedIds = op.scope_ids;
    const { scopeIds: currentIds } = await opType.buildScope(op.params, pool);
    const currentSet = new Set(currentIds);
    const previewedSet = new Set(previewedIds);

    const removedFromScope = previewedIds.filter((rowId) => !currentSet.has(rowId));
    const addedToScope = currentIds.filter((rowId) => !previewedSet.has(rowId));
    const toExecute = previewedIds.filter((rowId) => currentSet.has(rowId));

    const outcomes = [];
    for (const rowId of removedFromScope) {
      outcomes.push({ id: rowId, outcome: "skipped", reason: "scope_drift_removed" });
    }

    for (let i = 0; i < toExecute.length; i += BATCH_SIZE) {
      const batch = toExecute.slice(i, i + BATCH_SIZE);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const rowId of batch) {
          try {
            const result = await opType.executeRow(rowId, op.params, client);
            outcomes.push({ id: rowId, outcome: result.outcome, reason: result.reason || null });
          } catch (err) {
            outcomes.push({ id: rowId, outcome: "failed", reason: err.message || "unknown error" });
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        for (const rowId of batch) {
          outcomes.push({ id: rowId, outcome: "failed", reason: err.message || "batch failed" });
        }
      } finally {
        client.release();
      }
    }

    const summary = {
      total: previewedIds.length,
      changed: outcomes.filter((o) => o.outcome === "changed").length,
      skipped: outcomes.filter((o) => o.outcome === "skipped").length,
      failed: outcomes.filter((o) => o.outcome === "failed").length,
      scopeDrift: {
        removed: removedFromScope.length,
        added: addedToScope.length,
        addedSample: addedToScope.slice(0, DRIFT_SAMPLE_LIMIT),
      },
      rows: outcomes,
    };

    for (const o of outcomes) {
      bulkOpRowOutcomesTotal.inc({ type: op.type, outcome: o.outcome });
    }

    const finalStatus = summary.failed === 0 ? "completed" : summary.changed === 0 && summary.skipped === 0 ? "failed" : "partial";

    const updated = await pool.query(
      `UPDATE bulk_ops SET status = $2, outcomes = $3, finished_at = NOW() WHERE id = $1 RETURNING *`,
      [id, finalStatus, JSON.stringify(summary)],
    );

    bulkOpsTotal.inc({ type: op.type, status: finalStatus });
    const durationSeconds = (Date.now() - new Date(op.started_at).getTime()) / 1000;
    bulkOpDurationSeconds.observe({ type: op.type }, Math.max(durationSeconds, 0));

    await logAdminAction({
      actor: actorFor(actor),
      action: "bulk_op.confirm",
      targetType: "bulk_op",
      targetId: id,
      metadata: {
        type: op.type,
        status: finalStatus,
        scopeSummary: {
          total: summary.total,
          changed: summary.changed,
          skipped: summary.skipped,
          failed: summary.failed,
          scopeDrift: { removed: summary.scopeDrift.removed, added: summary.scopeDrift.added },
        },
      },
      ipAddress: ip,
    });

    return mapRow(updated.rows[0]);
  } catch (err) {
    await pool.query(
      `UPDATE bulk_ops SET status = 'failed', error = $2, finished_at = NOW() WHERE id = $1`,
      [id, err.message || "unknown error"],
    );
    await logAdminAction({
      actor: actorFor(actor),
      action: "bulk_op.confirm_rejected",
      targetType: "bulk_op",
      targetId: id,
      metadata: { type: op.type, reason: err.message || "unknown error" },
      ipAddress: ip,
    });
    throw err;
  }
}

/**
 * Step 3 (alternative to confirm): cancel a preview before it's confirmed.
 */
async function cancelOp({ id, actor, ip }) {
  const result = await pool.query(
    `UPDATE bulk_ops SET status = 'cancelled' WHERE id = $1 AND status = 'preview' RETURNING *`,
    [id],
  );
  if (!result.rows[0]) {
    const existing = await pool.query("SELECT * FROM bulk_ops WHERE id = $1", [id]);
    if (!existing.rows[0]) {
      throw new AppError("NOT_FOUND", { reason: "Bulk operation not found" });
    }
    throw new AppError("CONFLICT", { reason: `Bulk operation is already ${existing.rows[0].status}` });
  }

  await logAdminAction({
    actor: actorFor(actor),
    action: "bulk_op.cancel",
    targetType: "bulk_op",
    targetId: id,
    metadata: { type: result.rows[0].type },
    ipAddress: ip,
  });

  return mapRow(result.rows[0]);
}

/** Review endpoint: list recent ops with their outcomes. */
async function listOps({ status, type, page = 1, pageSize = 50 } = {}) {
  const where = [];
  const values = [];
  if (status) {
    values.push(status);
    where.push(`status = $${values.length}`);
  }
  if (type) {
    values.push(type);
    where.push(`type = $${values.length}`);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const limit = Math.min(Number(pageSize) || 50, 200);
  const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;
  values.push(limit, offset);

  const result = await pool.query(
    `SELECT * FROM bulk_ops ${whereSql} ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values,
  );
  return result.rows.map(mapRow);
}

module.exports = {
  registerOpType,
  getOpType,
  hashParams,
  createPreview,
  getOp,
  confirmOp,
  cancelOp,
  listOps,
  expireIfStale,
};
