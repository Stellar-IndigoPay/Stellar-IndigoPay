/**
 * backend/src/services/indexerDLQWorker.js
 *
 * Dead-letter queue (DLQ) worker for the indexer.
 *
 * Periodically polls the indexer_dlq table for entries whose next_retry_at
 * has passed and whose retry_count < max_retries. For each entry, it
 * retrieves the original transaction from Horizon and re-attempts donation
 * processing.
 *
 * On success, the DLQ entry is marked as resolved.
 * On failure, retry_count is incremented and next_retry_at is set using
 * exponential backoff (2^retry_count minutes).
 */
"use strict";

const pool = require("../db/pool");
const { server: stellarServer } = require("./stellar");
const { handleDonation } = require("./indexerDonationHandler");
const logger = require("../logger");

const DLQ_POLL_INTERVAL_MS = Number(
  process.env.INDEXER_DLQ_POLL_INTERVAL_MS || 60_000, // 1 min
);

const DLQ_BATCH_SIZE = Number(process.env.INDEXER_DLQ_BATCH_SIZE || 10);

// Base delay for exponential backoff in milliseconds.
// At retry_count=0: 1 minute; retry_count=1: 2 min; ...; retry_count=4: 16 min.
const DLQ_BACKOFF_BASE_MS = 60_000;

let pollTimer = null;
let isRunning = false;

/**
 * Calculate the next retry time using exponential backoff.
 *
 * @param {number} retryCount - Current number of retries.
 * @returns {Date} When the next retry should occur.
 */
function calculateNextRetry(retryCount) {
  const delayMs = DLQ_BACKOFF_BASE_MS * Math.pow(2, retryCount);
  // Cap at roughly 8 hours
  const cappedDelay = Math.min(delayMs, 8 * 60 * 60 * 1000);
  return new Date(Date.now() + cappedDelay);
}

/**
 * Process a single DLQ entry — re-fetches the transaction and attempts
 * to process it as a donation.
 *
 * @param {object} entry - Row from indexer_dlq.
 * @returns {Promise<boolean>} True if resolved successfully.
 */
async function processDLQEntry(entry) {
  const { id, transaction_hash, retry_count } = entry;

  try {
    // Fetch the transaction from Horizon
    const tx = await stellarServer.transactions().transaction(transaction_hash).call();
    if (!tx) {
      logger.warn(
        { event: "dlq_tx_not_found", id, txHash: transaction_hash },
        "Transaction not found on Horizon — marking as resolved",
      );
      await pool.query(
        "UPDATE indexer_dlq SET resolved_at = NOW() WHERE id = $1",
        [id],
      );
      return true;
    }

    // Fetch operations for this transaction
    const ops = await stellarServer.operations().forTransaction(transaction_hash).call();
    const paymentOps = (ops.records || []).filter((op) => op.type === "payment");

    if (paymentOps.length === 0) {
      // No payment ops in this tx — mark resolved
      await pool.query(
        "UPDATE indexer_dlq SET resolved_at = NOW() WHERE id = $1",
        [id],
      );
      return true;
    }

    // Get the wallet-to-project mapping
    const wallets = await pool.query(
      "SELECT id, wallet_address FROM projects WHERE status = 'active'",
    );
    const projectWallets = new Map();
    for (const row of wallets.rows) {
      projectWallets.set(row.wallet_address, row.id);
    }

    let anyProcessed = false;
    for (const op of paymentOps) {
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
        anyProcessed = true;
      } catch (err) {
        logger.error(
          { event: "dlq_reprocess_error", id, txHash: transaction_hash, err: err.message },
          "DLQ reprocessing failed for operation",
        );
      }
    }

    if (anyProcessed) {
      await pool.query(
        "UPDATE indexer_dlq SET resolved_at = NOW() WHERE id = $1",
        [id],
      );
      return true;
    }

    // No matching operations found — increment retry
    const nextRetry = calculateNextRetry(retry_count + 1);
    await pool.query(
      `UPDATE indexer_dlq
       SET retry_count = retry_count + 1,
           next_retry_at = $1
       WHERE id = $2`,
      [nextRetry, id],
    );
    return false;
  } catch (err) {
    // Error fetching from Horizon or processing — increment retry with backoff
    const nextRetry = calculateNextRetry(retry_count + 1);
    await pool.query(
      `UPDATE indexer_dlq
       SET retry_count = retry_count + 1,
           next_retry_at = $1
       WHERE id = $2`,
      [nextRetry, id],
    );
    logger.error(
      { event: "dlq_processing_error", id, txHash: transaction_hash, err: err.message },
      "DLQ entry processing failed — will retry",
    );
    return false;
  }
}

/**
 * Poll the DLQ for entries that need retrying.
 */
async function pollDLQ() {
  try {
    const result = await pool.query(
      `SELECT id, ledger, transaction_hash, error_message, retry_count, max_retries
       FROM indexer_dlq
       WHERE resolved_at IS NULL
         AND retry_count < max_retries
         AND next_retry_at <= NOW()
       ORDER BY next_retry_at ASC
       LIMIT $1`,
      [DLQ_BATCH_SIZE],
    );

    for (const entry of result.rows) {
      await processDLQEntry(entry);
    }

    if (result.rows.length > 0) {
      logger.debug(
        { event: "dlq_poll_completed", processed: result.rows.length },
        "DLQ poll cycle completed",
      );
    }
  } catch (err) {
    logger.error(
      { event: "dlq_poll_error", err: err.message },
      "DLQ poll failed",
    );
  }
}

/**
 * Start the DLQ worker polling loop.
 */
async function startDLQWorker() {
  if (isRunning) return;
  isRunning = true;

  logger.info(
    { event: "dlq_worker_started", intervalMs: DLQ_POLL_INTERVAL_MS },
    `Starting indexer DLQ worker every ${DLQ_POLL_INTERVAL_MS}ms`,
  );

  pollTimer = setInterval(pollDLQ, DLQ_POLL_INTERVAL_MS);
  if (typeof pollTimer.unref === "function") {
    pollTimer.unref();
  }

  // Run an initial poll immediately
  setImmediate(pollDLQ);
}

/**
 * Stop the DLQ worker. Idempotent.
 */
async function stopDLQWorker() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  isRunning = false;
}

/**
 * Enqueue a failed donation into the DLQ.
 *
 * @param {number} ledger - Ledger sequence the operation was on.
 * @param {string} transactionHash - The transaction hash.
 * @param {string} errorMessage - The error that caused the failure.
 */
async function enqueue(ledger, transactionHash, errorMessage) {
  try {
    await pool.query(
      `INSERT INTO indexer_dlq (ledger, transaction_hash, error_message, next_retry_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (transaction_hash) DO UPDATE SET
         retry_count = 0,
         error_message = EXCLUDED.error_message,
         resolved_at = NULL,
         next_retry_at = NOW()`,
      [ledger, transactionHash, errorMessage],
    );
    logger.warn(
      { event: "dlq_enqueued", ledger, txHash: transactionHash },
      "Donation processing failed — enqueued to DLQ",
    );
  } catch (err) {
    logger.error(
      { event: "dlq_enqueue_error", err: err.message },
      "Failed to enqueue to DLQ",
    );
  }
}

/**
 * Get DLQ status for health endpoint.
 */
async function getDLQStatus() {
  try {
    const pending = await pool.query(
      "SELECT COUNT(*)::bigint AS count FROM indexer_dlq WHERE resolved_at IS NULL AND retry_count < max_retries",
    );
    const exhausted = await pool.query(
      "SELECT COUNT(*)::bigint AS count FROM indexer_dlq WHERE resolved_at IS NULL AND retry_count >= max_retries",
    );
    return {
      pendingCount: Number(pending.rows[0]?.count || 0),
      exhaustedCount: Number(exhausted.rows[0]?.count || 0),
    };
  } catch {
    return { pendingCount: 0, exhaustedCount: 0 };
  }
}

module.exports = {
  startDLQWorker,
  stopDLQWorker,
  enqueue,
  getDLQStatus,
  pollDLQ,
};
