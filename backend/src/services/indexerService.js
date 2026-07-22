/**
 * backend/src/services/indexerService.js
 *
 * Horizon operations stream indexer with persistent cursor tracking,
 * custom reconnection backoff, dead-letter queue, and Prometheus metrics.
 *
 * Key improvements over the previous design:
 *   - Cursor is persisted in `indexer_state` table (survives restarts)
 *   - Custom exponential backoff for SSE reconnection (1s → 2s → 4s … 32s max)
 *   - Failed operations are enqueued to `indexer_dlq` for automatic retry
 *   - Prometheus metrics for stream health (lag, processed count, backfill count)
 *   - Atomic cursor update within the donation insert transaction
 *
 * USDC support (GF-004):
 *   - Detects credit_alphanum4 payments with asset_code "USDC" that match
 *     the configured USDC_TOKEN_ADDRESS.
 *   - Normalizes USDC amounts (7 decimal places) and converts to XLM-equivalent
 *     for raised_xlm increment and CO₂ calculation.
 *   - Falls back gracefully when USDC_TOKEN_ADDRESS is unset.
 */
"use strict";

const { server: stellarServer } = require("./stellar");
const pool = require("../db/pool");
const { handleDonation, setUsdcToXlmRate } = require("./indexerDonationHandler");
const { enqueue: enqueueDLQ } = require("./indexerDLQWorker");
const logger = require("../logger");
const { metrics } = require("./metrics");
const { runBackfill } = require("./indexerBackfill");

const {
  indigopayIndexerStreamReconnectsTotal: indexerStreamReconnects,
  indexerOperationsSkippedTotal: indexerOperationsSkipped,
  indigopayIndexerLagLedgers: indexerLagLedgers,
  indigopayIndexerAutoBackfillsTotal: indexerAutoBackfillsTotal,
} = metrics;

// ─── SSE reconnection backoff ───────────────────────────────────────────────
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MAX_MS = 32_000;
const BACKOFF_FACTOR = 2;

// ─── Internal state ─────────────────────────────────────────────────────────
let isRunning = false;
let io = null;
let projectWallets = new Map(); // wallet_address -> project_id
let projectWalletsInterval = null;
let horizonStream = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let lastProcessedLedger = 0;
let currentLag = 0;
let lagCheckTimer = null;
let lagCheckIntervalMs = Number(process.env.INDEXER_LAG_CHECK_INTERVAL_MS || 30_000);
let lagBackoffMs = lagCheckIntervalMs;
let maxLagBackoffMs = 5 * 60 * 1000;
let lastLagCheckAt = null;
let lastBackfillOutcome = null;

// ── USDC configuration ──────────────────────────────────────────────────────
let usdcTokenAddress = null;
let usdcToXlmRate = 8.0;

const USDC_ASSET_CODE = "USDC";

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Read the persisted cursor from indexer_state.
 */
async function readCursor() {
  try {
    const result = await pool.query(
      "SELECT last_processed_ledger FROM indexer_state WHERE key = 'primary'",
    );
    return result.rows[0]?.last_processed_ledger || 0;
  } catch (err) {
    logger.warn(
      { event: "indexer_cursor_read_error", err: err.message },
      "Cannot read cursor from DB, starting from 0",
    );
    return 0;
  }
}

/**
 * Atomically update the cursor (called WITHIN the donation transaction).
 */
async function updateCursor(client, ledger) {
  await client.query(
    `UPDATE indexer_state
     SET last_processed_ledger = GREATEST(last_processed_ledger, $1),
         last_processed_at = NOW()
     WHERE key = 'primary'`,
    [ledger],
  );
}

/**
 * Fetch all active project wallets and cache them, plus resolve USDC config.
 */
async function updateProjectWallets() {
  try {
    const result = await pool.query(
      "SELECT id, wallet_address FROM projects WHERE status = 'active'",
    );
    projectWallets.clear();
    for (const row of result.rows) {
      projectWallets.set(row.wallet_address, row.id);
    }
    logger.debug(
      { event: "indexer_wallets_refreshed", count: projectWallets.size },
      "Project wallet cache updated",
    );

    // ── Resolve USDC token address ──────────────────────────────────────────
    const envToken = process.env.USDC_TOKEN_ADDRESS;
    if (envToken && envToken.trim()) {
      usdcTokenAddress = envToken.trim();
      logger.info(
        { event: "usdc_token_configured", source: "env" },
        "USDC token address loaded from environment",
      );
    } else {
      try {
        const { getOnChainUsdcToken } = require("./stellar");
        const contractToken = await getOnChainUsdcToken();
        if (contractToken && contractToken.trim()) {
          usdcTokenAddress = contractToken.trim();
          logger.info(
            { event: "usdc_token_configured", source: "contract" },
            "USDC token address resolved from Soroban contract",
          );
        }
      } catch {
        // Non-fatal
      }
    }

    if (!usdcTokenAddress) {
      logger.warn(
        { event: "usdc_token_unconfigured" },
        "USDC_TOKEN_ADDRESS is not set — USDC payment indexing will be skipped",
      );
    }

    const rateFromEnv = process.env.USDC_TO_XLM_RATE;
    if (rateFromEnv && !isNaN(parseFloat(rateFromEnv))) {
      usdcToXlmRate = parseFloat(rateFromEnv);
      setUsdcToXlmRate(usdcToXlmRate);
    }
  } catch (err) {
    logger.error({ event: "indexer_wallets_refresh_error", err }, err.message);
  }
}

// ─── SSE stream ─────────────────────────────────────────────────────────────

/**
 * Open (or re-open) the Horizon SSE operations stream.
 * Uses the persisted cursor so restarts resume from where we left off.
 */
async function openStream() {
  const cursor = await readCursor();
  const cursorStr = cursor > 0 ? String(cursor) : "now";

  logger.info(
    { event: "indexer_stream_opening", cursor: cursorStr },
    `Opening Horizon operations stream at cursor ${cursorStr}`,
  );

  horizonStream = stellarServer
    .operations()
    .cursor(cursorStr)
    .stream({
      onmessage: async (op) => {
        try {
          lastProcessedLedger = Math.max(lastProcessedLedger, op.ledger_attr);

          if (op.type !== "payment") return;

          const isNative = op.asset_type === "native";
          const isUSDC =
            !isNative &&
            op.asset_code === USDC_ASSET_CODE &&
            usdcTokenAddress !== null &&
            op.asset_issuer === usdcTokenAddress;

          if (!isNative && !isUSDC) {
            indexerOperationsSkipped.inc({ reason: "unsupported_asset" });
            return;
          }

          const projectId = projectWallets.get(op.to);
          if (projectId) {
            const result = await handleDonation(projectId, op, { isNative, isUSDC, isBackfill: false }, {
              onCursorUpdate: updateCursor,
            });
            // Emit WebSocket event only for stream-processed donations (not backfill/DLQ)
            if (io && result) {
              io.emit("newDonation", {
                projectId,
                donorAddress: op.from,
                amountXLM: isNative ? parseFloat(op.amount) : null,
                amount: parseFloat(op.amount),
                currency: isNative ? "XLM" : "USDC",
                txHash: op.transaction_hash,
                timestamp: new Date().toISOString(),
              });
            }
          } else {
            indexerOperationsSkipped.inc({ reason: "no_matching_project" });
          }
        } catch (err) {
          logger.error({ event: "indexer_op_error", err: err.message }, "Operation processing error");
          enqueueDLQ(op.ledger_attr, op.transaction_hash, err.message).catch(() => {});
        }
      },
      onerror: (err) => {
        logger.error(
          { event: "indexer_horizon_stream_error", err: String(err) },
          "Horizon stream error — will reconnect with backoff",
        );
        closeStream();
        scheduleReconnect("stream_error");
      },
    });
}

/**
 * Close the current SSE stream. Idempotent.
 */
function closeStream() {
  try {
    if (horizonStream && typeof horizonStream.close === "function") {
      horizonStream.close();
    }
  } catch {
    // ignore
  } finally {
    horizonStream = null;
  }
}

/**
 * Schedule a reconnection with exponential backoff.
 */
function scheduleReconnect(reason) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectAttempt++;
  const delay = Math.min(
    BACKOFF_INITIAL_MS * Math.pow(BACKOFF_FACTOR, reconnectAttempt - 1),
    BACKOFF_MAX_MS,
  );

  indexerStreamReconnects.inc();

  logger.info(
    { event: "indexer_reconnect_scheduled", attempt: reconnectAttempt, delayMs: delay },
    `Reconnecting horizon stream in ${delay}ms (attempt ${reconnectAttempt})`,
  );

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await openStream();
      // Reset backoff on successful reconnection
      reconnectAttempt = 0;
    } catch (err) {
      logger.error(
        { event: "indexer_reconnect_failed", err: err.message },
        "Stream reconnection failed",
      );
      scheduleReconnect("reconnect_failed");
    }
  }, delay);

  if (typeof reconnectTimer.unref === "function") {
    reconnectTimer.unref();
  }
}

async function checkLag() {
  const checkResult = {
    lag: currentLag,
    triggeredBackfill: false,
    outcome: null,
  };

  try {
    const cursor = await readCursor();
    const ledgerRoot = await stellarServer.ledgers().order("desc").limit(1).call();
    const latestLedger = ledgerRoot?.records?.[0]?.sequence || cursor;
    const lag = Math.max(0, latestLedger - cursor);
    lastProcessedLedger = Math.max(lastProcessedLedger, cursor);
    currentLag = lag;
    checkResult.lag = lag;
    lastLagCheckAt = Date.now();
    indexerLagLedgers.set(lag);

    if (lag >= Number(process.env.INDEXER_LAG_BACKFILL_THRESHOLD || 10)) {
      checkResult.triggeredBackfill = true;
      try {
        const result = await runBackfill({ fromLedger: cursor + 1, toLedger: latestLedger });
        const outcome = result.errors > 0 ? "partial" : "success";
        indexerAutoBackfillsTotal.inc({ outcome });
        lastBackfillOutcome = outcome;
        checkResult.outcome = outcome;
        lagBackoffMs = Math.max(lagCheckIntervalMs, 1000);
        logger.warn(
          { event: "indexer_auto_backfill_triggered", lag, fromLedger: cursor + 1, toLedger: latestLedger, outcome },
          "Autonomous micro-backfill triggered after lag detection",
        );
      } catch (err) {
        indexerAutoBackfillsTotal.inc({ outcome: "failed" });
        lastBackfillOutcome = "failed";
        checkResult.outcome = "failed";
        lagBackoffMs = Math.min(Math.max(lagBackoffMs * 2, lagCheckIntervalMs), maxLagBackoffMs);
        logger.error(
          { event: "indexer_auto_backfill_failed", lag, err: err.message },
          "Autonomous micro-backfill failed",
        );
      }
    } else {
      lagBackoffMs = Math.max(lagCheckIntervalMs, 1000);
    }
  } catch (err) {
    checkResult.error = err.message;
    logger.error({ event: "indexer_lag_check_error", err: err.message }, "Lag check failed");
  }

  startLagMonitor();
  return checkResult;
}

function startLagMonitor() {
  if (lagCheckTimer) {
    clearInterval(lagCheckTimer);
    lagCheckTimer = null;
  }

  lagCheckTimer = setInterval(() => {
    checkLag().catch(() => {});
  }, lagBackoffMs);

  if (typeof lagCheckTimer.unref === "function") {
    lagCheckTimer.unref();
  }
}

function stopLagMonitor() {
  if (lagCheckTimer) {
    clearInterval(lagCheckTimer);
    lagCheckTimer = null;
  }
}

function setLagRuntimeState(state = {}) {
  if (state.currentLag !== undefined) {
    currentLag = state.currentLag;
  } else if (state.currentCursorLedger !== undefined && state.latestLedger !== undefined) {
    currentLag = Math.max(0, state.latestLedger - state.currentCursorLedger);
  }

  if (state.lastProcessedLedger !== undefined) {
    lastProcessedLedger = state.lastProcessedLedger;
  }

  lastLagCheckAt = state.lastCheckedAt ?? lastLagCheckAt;
  lagBackoffMs = state.backoffMs ?? lagBackoffMs;
  lastBackfillOutcome = state.lastBackfillOutcome ?? lastBackfillOutcome;
}

function getLagRuntimeState() {
  return {
    currentLag,
    lastProcessedLedger,
    lastCheckedAt: lastLagCheckAt,
    backoffMs: lagBackoffMs,
    lastBackfillOutcome,
  };
}

function resetLagRuntimeState() {
  currentLag = 0;
  lastProcessedLedger = 0;
  lastLagCheckAt = null;
  lagBackoffMs = Number(process.env.INDEXER_LAG_CHECK_INTERVAL_MS || 30_000);
  lastBackfillOutcome = null;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

/**
 * Start the Stellar indexer service.
 * @param {object} socketIo - The Socket.io server instance.
 */
async function startIndexer(socketIo) {
  if (isRunning) return;
  isRunning = true;
  io = socketIo;

  await updateProjectWallets();
  projectWalletsInterval = setInterval(updateProjectWallets, 10 * 60 * 1000);
  if (typeof projectWalletsInterval.unref === "function")
    projectWalletsInterval.unref();

  lagBackoffMs = Number(process.env.INDEXER_LAG_CHECK_INTERVAL_MS || 30_000);
  await checkLag();

  logger.info(
    { event: "indexer_started", usdcEnabled: Boolean(usdcTokenAddress) },
    "Starting Horizon operations stream" +
      (usdcTokenAddress ? " (USDC indexing enabled)" : ""),
  );

  await openStream();
}

/**
 * Returns the indexer status for the health endpoint.
 */
function getStatus() {
  return {
    isRunning,
    lastProcessedLedger,
    projectWalletsCount: projectWallets.size,
    usdcTokenConfigured: Boolean(usdcTokenAddress),
    usdcToXlmRate,
    reconnectAttempt,
    lagLedgers: currentLag,
    lastLagCheckAt,
    backoffMs: lagBackoffMs,
    lastBackfillOutcome,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Stop the indexer. Idempotent.
 */
async function stop() {
  closeStream();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (projectWalletsInterval) {
    clearInterval(projectWalletsInterval);
    projectWalletsInterval = null;
  }

  stopLagMonitor();

  isRunning = false;
  reconnectAttempt = 0;
}

module.exports = {
  startIndexer,
  getStatus,
  stop,
  handleDonation,
  updateProjectWallets,
  checkLag,
  runLagCheck: checkLag,
  setLagRuntimeState,
  getLagRuntimeState,
  resetLagRuntimeState,
};
