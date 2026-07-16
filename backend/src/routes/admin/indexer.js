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
    res.status(500).json({
      success: false,
      error: err.message || "Backfill failed",
    });
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
        indexer: indexerStatus,
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
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
