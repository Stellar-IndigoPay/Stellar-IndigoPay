/**
 * backend/src/routes/admin/indexer.js
 *
 * Admin API routes for indexer management.
 *
 * Endpoints:
 *   POST /api/admin/indexer/backfill  — trigger a manual backfill
 *   GET  /api/admin/indexer/status    — get indexer status + DLQ stats
 */
"use strict";

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");
const { runBackfill } = require("../../services/indexerBackfill");
const { getDLQStatus } = require("../../services/indexerDLQWorker");
const { getStatus } = require("../../services/indexerService");
const { getStatus: getReconcilerStatus } = require("../../services/indexerReconciler");
const pool = require("../../db/pool");
const logger = require("../../logger");
const { sendAppError } = require("../../errors");

/**
 * Trigger a manual backfill.
 *
 * POST /api/admin/indexer/backfill
 * Body (optional):
 *   { fromLedger?: number, toLedger?: number, force?: boolean }
 *
 * Returns the backfill result with processed/error counts.
 */
router.post("/backfill", adminRequired, async (req, res) => {
  try {
    const { fromLedger, toLedger, force } = req.body || {};

    // Run backfill asynchronously — don't block the response
    const resultPromise = runBackfill({ fromLedger, toLedger, force: Boolean(force) });

    // Return a 202 with the promise result
    const result = await resultPromise;

    logger.info(
      { event: "admin_backfill_triggered", result },
      "Admin triggered indexer backfill",
    );

    res.status(202).json({
      success: true,
      data: {
        message: result.skipped
          ? "Backfill skipped — already in progress"
          : result.noop
            ? "Backfill not needed — indexer is caught up"
            : "Backfill completed",
        result,
      },
    });
  } catch (err) {
    logger.error(
      { event: "admin_backfill_error", err: err.message },
      "Admin backfill failed",
    );
    return sendAppError(res, "INTERNAL_ERROR");
  }
});

/**
 * Get indexer status, including DLQ and reconciler state.
 *
 * GET /api/admin/indexer/status
 */
router.get("/status", adminRequired, async (req, res) => {
  try {
    const indexerStatus = getStatus();
    const dlqStatus = await getDLQStatus();
    const reconcilerStatus = getReconcilerStatus();

    const stateResult = await pool.query(
      "SELECT last_processed_ledger, backfill_in_progress, reconciled_at FROM indexer_state WHERE key = 'primary'",
    );
    const cursorState = stateResult.rows[0] || {};

    res.json({
      success: true,
      data: {
        indexer: {
          ...indexerStatus,
          lagLedgers: indexerStatus.lagLedgers ?? indexerStatus.lag_ledgers,
          status: indexerStatus.lagLedgers > 50 ? "degraded" : indexerStatus.isRunning ? "ok" : "degraded",
        },
        cursor: {
          lastProcessedLedger: cursorState.last_processed_ledger,
          backfillInProgress: cursorState.backfill_in_progress,
          reconciledAt: cursorState.reconciled_at,
        },
        dlq: dlqStatus,
        reconciler: reconcilerStatus,
      },
    });
  } catch (err) {
    return sendAppError(res, "INTERNAL_ERROR");
  }
});


/**
 * Rescan a specific ledger range.
 */
router.post("/rescan", adminRequired, async (req, res) => {
  try {
    const { fromLedger, toLedger } = req.body || {};
    if (typeof fromLedger !== "number" || typeof toLedger !== "number") {
      return sendAppError(res, "VALIDATION_ERROR", { detail: "fromLedger and toLedger required" });
    }
    
    // Trigger in both services
    const { rescanRange: indexerRescan } = require("../../services/indexerService");
    const { rescanRange: sorobanRescan } = require("../../services/sorobanEventService");
    
    // Do not block the response
    Promise.all([
      indexerRescan({ fromLedger, toLedger }),
      sorobanRescan({ fromLedger, toLedger })
    ]).catch(err => logger.error({ err: err.message }, "Rescan failed"));
    
    res.status(202).json({ success: true, message: "Rescan started" });
  } catch (err) {
    logger.error({ event: "admin_rescan_error", err: err.message }, "Admin rescan failed");
    return sendAppError(res, "INTERNAL_ERROR");
  }
});

/**
 * Get checkpoint info
 */
router.get("/checkpoint", adminRequired, async (req, res) => {
  try {
    const stateResult = await pool.query(
      "SELECT last_processed_ledger, last_processed_at, cursor_hash FROM indexer_state WHERE key = 'primary'"
    );
    const primary = stateResult.rows[0] || {};
    
    const sorobanResult = await pool.query(
      "SELECT value as last_processed_ledger, updated_at as last_processed_at, cursor_hash FROM indexer_state WHERE key = 'soroban_event_cursor'"
    );
    const soroban = sorobanResult.rows[0] || {};
    
    res.json({
      success: true,
      data: {
        primary: {
          ledger: primary.last_processed_ledger,
          timestamp: primary.last_processed_at,
          hash: primary.cursor_hash
        },
        soroban: {
          ledger: soroban.last_processed_ledger,
          timestamp: soroban.last_processed_at,
          hash: soroban.cursor_hash
        }
      }
    });
  } catch (err) {
    return sendAppError(res, "INTERNAL_ERROR");
  }
});

module.exports = router;
