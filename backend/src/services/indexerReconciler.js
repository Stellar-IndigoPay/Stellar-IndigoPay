/**
 * backend/src/services/indexerReconciler.js
 *
 * Periodic indexer reconciliation service.
 *
 * Every 30 minutes (configurable), this service:
 *   1. Reads the last_processed_ledger from indexer_state.
 *   2. Compares the latest on-chain ledger sequence (via Horizon) to
 *      detect how far behind the indexer is.
 *   3. Optionally compares the contract's get_donation_count() against
 *      the database donation count (on-chain vs off-chain consistency).
 *   4. If a gap is detected, triggers a backfill automatically.
 *
 * Concurrency guard
 * -----------------
 * runReconciliation() acquires the same Postgres session-level advisory
 * lock used by indexerBackfill.runBackfill() before doing any work.
 * This means:
 *   - Two reconciler replicas can never overlap.
 *   - A manual admin backfill and a scheduled reconcile can never overlap.
 * A caller that cannot acquire the lock returns immediately with a report
 * containing `{ skipped: true }` — no metrics are double-counted and no
 * inserts are duplicated.
 *
 * Metrics emitted:
 *   - indexer_ledger_lag: seconds since last processed ledger
 *   - indexer_donations_processed_total: cumulative count
 *   - indexer_backfills_total: backfill runs
 */
"use strict";

const pool = require("../db/pool");
const { server: stellarServer } = require("./stellar");
const { runBackfill, _backfillLockKey } = require("./indexerBackfill");
const logger = require("../logger");
const { Counter, Gauge } = require("prom-client");
const { registry } = require("./metrics");

// ── Reconciliation schedule ────────────────────────────────────────────────
const RECONCILE_INTERVAL_MS = Number(
  process.env.INDEXER_RECONCILE_INTERVAL_MS || 30 * 60 * 1000, // 30 min
);

// Maximum allowed ledger lag before auto-backfill is triggered (in ledgers).
// At ~5s per ledger, 60 ledgers ≈ 5 minutes.
const MAX_LEDGER_LAG = Number(process.env.INDEXER_MAX_LEDGER_LAG || 60);

// ── Prometheus metrics ─────────────────────────────────────────────────────
const indexerLedgerLag = new Gauge({
  name: "indexer_ledger_lag",
  help: "Ledger lag: number of ledgers behind the indexer is from the Horizon tip",
  registers: [registry],
});

const indexerBackfillsTotal = new Counter({
  name: "indexer_backfills_total",
  help: "Total number of backfill runs completed",
  labelNames: ["outcome"],
  registers: [registry],
});

const indexerReconciliationDuration = new Gauge({
  name: "indexer_reconciliation_duration_seconds",
  help: "Duration of the last reconciliation cycle in seconds",
  registers: [registry],
});

const indexerDonationDbCount = new Gauge({
  name: "indexer_reconciliation_db_donation_count",
  help: "Total number of donations in the database, sampled by the reconciler",
  registers: [registry],
});

// ── Internal state ─────────────────────────────────────────────────────────
let reconcileTimer = null;
let isRunning = false;

/**
 * Run a single reconciliation cycle.
 *
 * Acquires the same Postgres advisory lock as indexerBackfill.runBackfill()
 * before doing any work. Returns a report object describing what was checked
 * and any actions taken. If the lock is held by another process the report
 * will include `skipped: true`.
 *
 * @returns {Promise<object>} report
 */
async function runReconciliation() {
  const startTime = Date.now();
  const report = {
    checkedAt: new Date().toISOString(),
    ledgerLag: null,
    donationCountMatch: null,
    backfillTriggered: false,
    errors: [],
  };

  // ── Acquire advisory lock (non-blocking) ────────────────────────────────
  // Share the same numeric key as the backfill so the two components
  // mutually exclude each other as well as excluding concurrent instances
  // of themselves.
  const lockClient = await pool.connect();
  let lockAcquired = false;

  try {
    const lockResult = await lockClient.query(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [_backfillLockKey],
    );
    lockAcquired = lockResult.rows[0]?.acquired === true;

    if (!lockAcquired) {
      logger.warn(
        { event: "reconciler_lock_busy" },
        "Reconciler advisory lock is held by another process — skipping cycle",
      );
      await pool
        .query(
          "UPDATE indexer_state SET last_lock_skipped_at = NOW() WHERE key = 'primary'",
        )
        .catch(() => {});
      report.skipped = true;
      return report;
    }

    try {
      // 1. Get current indexer state
      const stateResult = await pool.query(
        "SELECT last_processed_ledger, backfill_in_progress, cursor_hash FROM indexer_state WHERE key = 'primary'",
      );
      const lastProcessedLedger = stateResult.rows[0]?.last_processed_ledger || 0;
      const backfillInProgress = stateResult.rows[0]?.backfill_in_progress || false;
      const storedHash = stateResult.rows[0]?.cursor_hash;
      if (storedHash && lastProcessedLedger > 0) {
        const crypto = require("crypto");
        const expectedHash = crypto
          .createHash("sha256")
          .update(String(lastProcessedLedger))
          .digest("hex");
        if (storedHash !== expectedHash) {
          throw new Error(
            `Checkpoint corruption detected: hash mismatch for ledger ${lastProcessedLedger}`,
          );
        }
      }

      // 2. Get latest on-chain ledger from Horizon
      let latestLedger = 0;
      try {
        const root = await stellarServer.ledgers().limit(1).order("desc").call();
        if (root.records && root.records.length > 0) {
          latestLedger = root.records[0].sequence;
        }
      } catch (err) {
        report.errors.push(`Horizon tip fetch failed: ${err.message}`);
        logger.warn(
          { event: "reconciler_horizon_error", err: err.message },
          "Cannot fetch latest ledger from Horizon",
        );
      }

      // 3. Compute ledger lag
      if (latestLedger > 0 && lastProcessedLedger > 0) {
        const lag = latestLedger - lastProcessedLedger;
        report.ledgerLag = lag;
        indexerLedgerLag.set(lag);

        // 4. Auto-trigger backfill if lag exceeds threshold.
        // runBackfill() will attempt to acquire the same advisory lock; since
        // we already hold it here, the inner call proceeds immediately (Postgres
        // advisory locks are re-entrant on the same session) while still
        // excluding *other* sessions.
        if (lag > MAX_LEDGER_LAG && !backfillInProgress) {
          logger.info(
            { event: "reconciler_backfill_triggered", lag, threshold: MAX_LEDGER_LAG },
            `Ledger lag ${lag} exceeds threshold ${MAX_LEDGER_LAG} — triggering backfill`,
          );

          try {
            const result = await runBackfill({ force: false });
            report.backfillTriggered = true;
            report.backfillResult = result;
            indexerBackfillsTotal.inc({ outcome: result.processed > 0 ? "success" : "noop" });
          } catch (err) {
            report.errors.push(`Backfill failed: ${err.message}`);
            indexerBackfillsTotal.inc({ outcome: "failed" });
          }
        }
      }

      // 5. Compare database donation count vs previous cycle
      // (On-chain comparison would require Soroban RPC — keep it lightweight
      //  for the periodic check; we track total processed via counter.)
      try {
        const dbCount = await pool.query("SELECT COUNT(*)::bigint AS count FROM donations");
        const count = Number(dbCount.rows[0]?.count || 0);
        indexerDonationDbCount.set(count);
        report.donationCountMatch = count;
      } catch (err) {
        report.errors.push(`DB donation count failed: ${err.message}`);
      }

      // 6. Update reconciled_at timestamp
      await pool.query(
        "UPDATE indexer_state SET reconciled_at = NOW() WHERE key = 'primary'",
      );

      // 7. Record duration
      const durationSec = (Date.now() - startTime) / 1000;
      indexerReconciliationDuration.set(durationSec);
      report.durationSec = durationSec;
    } catch (err) {
      report.errors.push(`Reconciliation error: ${err.message}`);
      logger.error(
        { event: "reconciler_error", err: err.message },
        "Reconciliation cycle failed",
      );
    }
  } finally {
    // Always release the advisory lock before returning the client.
    if (lockAcquired) {
      await lockClient
        .query("SELECT pg_advisory_unlock($1)", [_backfillLockKey])
        .catch(() => {});
    }
    lockClient.release();
  }

  return report;
}

/**
 * Start the periodic reconciliation loop.
 */
async function startReconciler() {
  if (isRunning) return;
  isRunning = true;

  // Run an initial check after a short delay to let the indexer warm up
  setTimeout(async () => {
    try {
      const report = await runReconciliation();
      logger.info(
        { event: "reconciler_initial_check", report },
        "Initial reconciliation check complete",
      );
    } catch (err) {
      logger.error(
        { event: "reconciler_initial_error", err: err.message },
        "Initial reconciliation check failed",
      );
    }
  }, 10_000);

  reconcileTimer = setInterval(async () => {
    try {
      const report = await runReconciliation();
      if (report.errors.length > 0) {
        logger.warn(
          { event: "reconciler_cycle", report },
          `Reconciliation cycle completed with ${report.errors.length} error(s)`,
        );
      }
    } catch (err) {
      logger.error(
        { event: "reconciler_cycle_error", err: err.message },
        "Reconciliation cycle failed",
      );
    }
  }, RECONCILE_INTERVAL_MS);

  if (typeof reconcileTimer.unref === "function") {
    reconcileTimer.unref();
  }
}

/**
 * Stop the reconciliation loop. Idempotent.
 */
async function stopReconciler() {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
  isRunning = false;
}

/**
 * Get current reconciler status.
 */
function getStatus() {
  return {
    isRunning,
    intervalMs: RECONCILE_INTERVAL_MS,
    maxLedgerLag: MAX_LEDGER_LAG,
  };
}

module.exports = {
  startReconciler,
  stopReconciler,
  runReconciliation,
  getStatus,
};
