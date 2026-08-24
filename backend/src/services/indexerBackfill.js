/**
 * backend/src/services/indexerBackfill.js
 *
 * Indexer backfill service — replays Horizon operations from a given cursor
 * (ledger sequence) forward to the current ledger tip, processing any
 * unmatched payments through the standard donation pipeline.
 *
 * Used by:
 *   - indexerReconciler.js (automatic gap filling every 30 min)
 *   - Admin API POST /api/v1/admin/indexer/backfill (manual trigger)
 *
 * Concurrency guard
 * -----------------
 * Calls from multiple replicas or overlapping reconciler cycles are
 * serialised with a Postgres session-level advisory lock. Only one
 * process can hold the lock at a time. Concurrent callers call
 * `pg_try_advisory_lock` (non-blocking), receive `false`, and return
 * immediately with `{ skipped: true }` — no work is duplicated and no
 * rows are double-inserted.
 *
 * Idempotent inserts
 * ------------------
 * `handleDonation` issues:
 *   INSERT … ON CONFLICT DO NOTHING
 * keyed on (transaction_hash, indexer_operation_id) via the partial unique
 * indexes added by migration 028 (donations table) and 030 (donation_events).
 * Even if the advisory lock were somehow skipped, the DB constraint prevents
 * duplicate rows.
 */
"use strict";

const { server: stellarServer } = require("./stellar");
const pool = require("../db/pool");
const logger = require("../logger");
const { handleDonation } = require("./indexerService");

const BACKFILL_BATCH_SIZE = Number(process.env.INDEXER_BACKFILL_BATCH_SIZE || 200);
const BACKFILL_PAUSE_MS = Number(process.env.INDEXER_BACKFILL_PAUSE_MS || 100);

// ── Advisory-lock key ─────────────────────────────────────────────────────
// Deterministic 64-bit FNV-1a hash of "indigopay_indexer_backfill", masked
// to the signed int8 range that pg_advisory_lock accepts. Both backfill and
// reconciler share the same key so they mutually exclude each other as well
// as excluding concurrent instances of themselves.
const BACKFILL_LOCK_NAME = "indigopay_indexer_backfill";

/**
 * FNV-1a 64-bit hash of `str`, masked to the signed int8 Postgres range.
 * @param {string} str
 * @returns {bigint}
 */
function fnv1a64(str) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < str.length; i += 1) {
    hash ^= BigInt(str.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  // Mask to signed int8 range so pg_advisory_lock doesn't error.
  return hash & 0x7fffffffffffffffn;
}

const BACKFILL_LOCK_KEY = fnv1a64(BACKFILL_LOCK_NAME);

/**
 * Run a backfill from the specified start ledger up to the current tip.
 *
 * The entire body executes under a Postgres session-level advisory lock so
 * only one replica runs the backfill at a time. A concurrent caller that
 * cannot acquire the lock returns `{ skipped: true }` immediately.
 *
 * @param {object} [options]
 * @param {number}  [options.fromLedger]  - Start ledger (inclusive). Defaults to the
 *                                          last_processed_ledger from indexer_state.
 * @param {number}  [options.toLedger]    - End ledger (inclusive). Defaults to the
 *                                          latest ledger from Horizon.
 * @param {boolean} [options.force]       - If true, runs even if backfill_in_progress is set.
 * @returns {Promise<{ processed: number, errors: number, fromLedger: number, toLedger: number }>}
 */
async function runBackfill(options = {}) {
  const { fromLedger, toLedger, force } = options;

  // ── Acquire advisory lock (non-blocking) ────────────────────────────────
  // We check out a dedicated client so the advisory lock lifetime is exactly
  // the duration of this function call; the lock is released by either
  // pg_advisory_unlock (happy path) or the connection being returned to the
  // pool (unhappy path / error).
  const lockClient = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [BACKFILL_LOCK_KEY],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;

    if (!lockAcquired) {
      logger.warn(
        { event: "backfill_lock_busy" },
        "Backfill advisory lock is held by another process — skipping",
      );
      // Record the skipped attempt so operators can see it in indexer_state.
      await pool
        .query(
          "UPDATE indexer_state SET last_lock_skipped_at = NOW() WHERE key = 'primary'",
        )
        .catch(() => {});
      return { processed: 0, errors: 0, fromLedger: 0, toLedger: 0, skipped: true };
    }

    // ── Check / set backfill-in-progress flag ───────────────────────────────
    if (!force) {
      const state = await pool.query(
        "SELECT backfill_in_progress FROM indexer_state WHERE key = 'primary'",
      );
      if (state.rows.length > 0 && state.rows[0].backfill_in_progress) {
        logger.warn(
          { event: "backfill_already_running" },
          "Backfill already in progress — skipping",
        );
        return { processed: 0, errors: 0, fromLedger: 0, toLedger: 0, skipped: true };
      }
    }

    // Mark backfill as in progress
    await pool.query(
      "UPDATE indexer_state SET backfill_in_progress = true WHERE key = 'primary'",
    );

    try {
      // ── Determine ledger range ───────────────────────────────────────────
      let startLedger = fromLedger;
      if (!startLedger) {
        const state = await pool.query(
          "SELECT last_processed_ledger, cursor_hash FROM indexer_state WHERE key = 'primary'",
        );
        const ledger = state.rows[0]?.last_processed_ledger || 0;
        const storedHash = state.rows[0]?.cursor_hash;

        if (storedHash && ledger > 0) {
          const crypto = require("crypto");
          const expectedHash = crypto
            .createHash("sha256")
            .update(String(ledger))
            .digest("hex");
          if (storedHash !== expectedHash) {
            throw new Error(
              `Checkpoint corruption detected: hash mismatch for ledger ${ledger}`,
            );
          }
        }

        startLedger = ledger;
      }

      let endLedger = toLedger;
      if (!endLedger) {
        try {
          const root = await stellarServer.ledgers().limit(1).order("desc").call();
          if (root.records && root.records.length > 0) {
            endLedger = root.records[0].sequence;
          }
        } catch (err) {
          logger.error(
            { event: "backfill_fetch_tip_error", err: err.message },
            "Cannot fetch latest ledger sequence for backfill",
          );
          throw err;
        }
      }

      if (!endLedger || endLedger <= startLedger) {
        logger.info(
          { event: "backfill_noop", startLedger, endLedger },
          "Backfill start >= end, nothing to process",
        );
        return { processed: 0, errors: 0, fromLedger: startLedger, toLedger: endLedger, noop: true };
      }

      logger.info(
        { event: "backfill_started", fromLedger: startLedger, toLedger: endLedger },
        `Starting backfill from ledger ${startLedger} to ${endLedger}`,
      );

      // ── Build wallet cache for this backfill ──────────────────────────────
      const wallets = await pool.query(
        "SELECT id, wallet_address FROM projects WHERE status = 'active'",
      );
      const projectWallets = new Map();
      for (const row of wallets.rows) {
        projectWallets.set(row.wallet_address, row.id);
      }

      // ── Paginated replay ─────────────────────────────────────────────────
      let processed = 0;
      let errors = 0;
      let cursor = "now";
      let hasMore = true;
      let latestProcessed = startLedger;

      // Use Horizon's operation endpoint with cursor = startLedger to begin
      // from the ledger we want.
      cursor = startLedger > 0 ? String(startLedger) : "now";

      while (hasMore) {
        try {
          const opsPage = await stellarServer
            .operations()
            .cursor(cursor)
            .limit(BACKFILL_BATCH_SIZE)
            .order("asc")
            .call();

          const records = opsPage.records || [];
          if (records.length === 0) {
            hasMore = false;
            break;
          }

          for (const op of records) {
            // Stop if we've passed the target ledger
            if (endLedger && op.ledger_attr > endLedger) {
              hasMore = false;
              break;
            }

            // Only process payment operations
            if (op.type !== "payment") continue;

            // Check if this is a project wallet recipient
            const projectId = projectWallets.get(op.to);
            if (!projectId) continue;

            try {
              await handleDonation(projectId, op, {
                isNative: op.asset_type === "native",
                isUSDC:
                  op.asset_type === "credit_alphanum4" &&
                  op.asset_code === "USDC" &&
                  op.asset_issuer !== undefined,
                isBackfill: true,
              });
              processed++;
            } catch (err) {
              errors++;
              logger.error(
                {
                  event: "backfill_op_error",
                  ledger: op.ledger_attr,
                  txHash: op.transaction_hash,
                  err: err.message,
                },
                "Backfill operation failed",
              );
            }

            latestProcessed = Math.max(latestProcessed, op.ledger_attr);
          }

          // Update cursor for next page
          if (records.length > 0) {
            const last = records[records.length - 1];
            cursor = last.paging_token || String(last.ledger_attr);
          }

          // Small pause between pages to avoid Horizon rate limiting
          if (hasMore && BACKFILL_PAUSE_MS > 0) {
            await new Promise((r) => setTimeout(r, BACKFILL_PAUSE_MS));
          }

          // Check if we've reached the target
          if (endLedger && latestProcessed >= endLedger) {
            hasMore = false;
          }
        } catch (err) {
          logger.error(
            { event: "backfill_page_error", cursor, err: err.message },
            "Error fetching backfill page — will retry",
          );
          // Wait a bit longer before retrying a page
          await new Promise((r) => setTimeout(r, 1000));
        }
      }

      // ── Update cursor ────────────────────────────────────────────────────
      await pool.query(
        `UPDATE indexer_state
         SET last_processed_ledger = GREATEST(last_processed_ledger, $1),
             backfill_in_progress = false,
             backfill_target_ledger = NULL,
             last_processed_at = NOW()
         WHERE key = 'primary'`,
        [latestProcessed],
      );

      logger.info(
        { event: "backfill_completed", processed, errors, toLedger: latestProcessed },
        `Backfill completed: ${processed} processed, ${errors} errors`,
      );

      return { processed, errors, fromLedger: startLedger, toLedger: latestProcessed };
    } catch (err) {
      // Clear the in-progress flag on failure so a subsequent attempt can run
      await pool.query(
        "UPDATE indexer_state SET backfill_in_progress = false WHERE key = 'primary'",
      ).catch(() => {});

      logger.error(
        { event: "backfill_failed", err: err.message },
        "Backfill failed",
      );
      throw err;
    }
  } finally {
    // Always release the advisory lock before returning the client to the pool.
    if (lockAcquired) {
      await lockClient
        .query("SELECT pg_advisory_unlock($1)", [BACKFILL_LOCK_KEY])
        .catch(() => {});
    }
    lockClient.release();
  }
}

module.exports = {
  runBackfill,
  // Exported for testing only
  _backfillLockKey: BACKFILL_LOCK_KEY,
};
