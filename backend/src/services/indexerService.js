/**
 * backend/src/services/indexerService.js
 *
 * Horizon operations stream indexer.
 *
 * Listens for Stellar payments (both native XLM and USDC) on the Horizon
 * SSE stream and records them as donations in the database.
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
const { v4: uuid } = require("uuid");
const { computeBadges } = require("./store");
const { checkAndDeliverMilestones } = require("./webhook");
const logger = require("../logger");

let lastProcessedLedger = 0;
let isRunning = false;
let io = null;
let projectWallets = new Map(); // wallet_address -> project_id
let projectWalletsInterval = null;
let horizonStream = null;

// ── USDC configuration ──────────────────────────────────────────────────────
// Resolved at startup in updateProjectWallets(). Falls back to env var,
// then attempts a Soroban RPC call to get_usdc_token(). If all fail,
// USDC indexing is skipped with a warning.
let usdcTokenAddress = null;
let usdcToXlmRate = 8.0; // default: 1 USDC ≈ 8 XLM

// Stellar asset code for USD Coin (credit_alphanum4).
const USDC_ASSET_CODE = "USDC";

/**
 * Fetch all active project wallets and cache them.
 * Also resolves the USDC token address from env or contract.
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
      // Attempt Soroban RPC fallback
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
        // Non-fatal — USDC indexing will be skipped
      }
    }

    if (!usdcTokenAddress) {
      logger.warn(
        { event: "usdc_token_unconfigured" },
        "USDC_TOKEN_ADDRESS is not set — USDC payment indexing will be skipped. Set USDC_TOKEN_ADDRESS env var to enable.",
      );
    }

    // Parse the USDC→XLM conversion rate
    const rateFromEnv = process.env.USDC_TO_XLM_RATE;
    if (rateFromEnv && !isNaN(parseFloat(rateFromEnv))) {
      usdcToXlmRate = parseFloat(rateFromEnv);
    }
  } catch (err) {
    logger.error({ event: "indexer_wallets_refresh_error", err }, err.message);
  }
}

/**
 * Start the Stellar indexer service.
 * @param {Object} socketIo - The Socket.io server instance.
 */
async function startIndexer(socketIo) {
  if (isRunning) return;
  isRunning = true;
  io = socketIo;

  await updateProjectWallets();
  projectWalletsInterval = setInterval(updateProjectWallets, 10 * 60 * 1000);
  if (typeof projectWalletsInterval.unref === "function")
    projectWalletsInterval.unref();

  logger.info(
    { event: "indexer_started", usdcEnabled: Boolean(usdcTokenAddress) },
    "Starting Horizon operations stream" +
      (usdcTokenAddress ? " (USDC indexing enabled)" : ""),
  );

  horizonStream = stellarServer
    .operations()
    .cursor("now")
    .stream({
      onmessage: async (op) => {
        try {
          lastProcessedLedger = op.ledger_attr;

          // We only care about payment operations
          if (op.type !== "payment") return;

          const isNative = op.asset_type === "native";
          const isUSDC =
            !isNative &&
            op.asset_code === USDC_ASSET_CODE &&
            usdcTokenAddress !== null &&
            op.asset_issuer === usdcTokenAddress;

          if (!isNative && !isUSDC) {
            // Unknown/unsupported asset — skip silently
            return;
          }

          const projectId = projectWallets.get(op.to);
          if (projectId) {
            await handleDonation(projectId, op, { isNative, isUSDC });
          }
        } catch (err) {
          logger.error({ event: "indexer_op_error", err }, err.message);
        }
      },
      onerror: (err) => {
        logger.error(
          { event: "indexer_horizon_stream_error", err },
          "Horizon stream error",
        );
      },
    });
}

/**
 * Handle a payment to a project — supports both native XLM and USDC.
 *
 * @param {string} projectId - Internal project UUID.
 * @param {object} op        - Horizon operation object.
 * @param {{ isNative: boolean, isUSDC: boolean }} flags
 */
async function handleDonation(projectId, op, { isNative, isUSDC }) {
  const txHash = op.transaction_hash;
  const donorAddress = op.from;

  // ── Determine currency and amounts ────────────────────────────────────────
  let currency;
  let amount; // stored in the `amount` column
  let amountXlmForRaised; // XLM-equivalent for raised_xlm increment
  let amountXlmForInsert; // stored in `amount_xlm` column (null for USDC)

  if (isNative) {
    currency = "XLM";
    amount = parseFloat(op.amount);
    amountXlmForRaised = amount;
    amountXlmForInsert = amount;
  } else if (isUSDC) {
    currency = "USDC";
    amount = parseFloat(op.amount);
    const xlmEquiv = amount * usdcToXlmRate;
    amountXlmForRaised = xlmEquiv;
    amountXlmForInsert = null; // Per schema: amount_xlm is null for non-XLM
  } else {
    // Should not reach here (filtered in onmessage)
    return;
  }

  if (isNaN(amount) || amount <= 0) return;

  const client = await pool.connect();
  let inTransaction = false;

  try {
    // 1. Deduplicate by transaction hash
    const existingResult = await client.query(
      "SELECT id FROM donations WHERE transaction_hash = $1",
      [txHash],
    );
    if (existingResult.rows.length > 0) {
      return;
    }

    await client.query("BEGIN");
    inTransaction = true;

    // 2. Record the donation
    const donationId = uuid();
    await client.query(
      `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [donationId, projectId, donorAddress, amountXlmForInsert, amount, currency, txHash],
    );

    // 3. Update project: raised_xlm uses the XLM-equivalent for both currencies
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1,
           donor_count = (SELECT COUNT(DISTINCT donor_address) FROM donations WHERE project_id = $2),
           updated_at = NOW()
       WHERE id = $2`,
      [amountXlmForRaised, projectId],
    );

    // 4. Update donor profile (total donated xlm, projects supported, badges)
    const existingProfileResult = await client.query(
      "SELECT total_donated_xlm FROM profiles WHERE public_key = $1",
      [donorAddress],
    );
    const existingProfile = existingProfileResult.rows[0];
    const previousTotal = existingProfile
      ? parseFloat(existingProfile.total_donated_xlm || "0")
      : 0;
    const newTotal = previousTotal + amountXlmForRaised;

    const projectsSupportedResult = await client.query(
      "SELECT COUNT(DISTINCT project_id) AS count FROM donations WHERE donor_address = $1",
      [donorAddress],
    );
    const projectsSupported =
      parseInt(projectsSupportedResult.rows[0].count, 10) || 1;
    const badges = computeBadges(newTotal);

    await client.query(
      `INSERT INTO profiles (public_key, total_donated_xlm, projects_supported, badges, created_at, updated_at)
       VALUES ($1, $2, $3, $4, NOW(), NOW())
       ON CONFLICT (public_key) DO UPDATE SET
         total_donated_xlm = EXCLUDED.total_donated_xlm,
         projects_supported = EXCLUDED.projects_supported,
         badges = EXCLUDED.badges,
         updated_at = NOW()`,
      [donorAddress, newTotal.toFixed(7), projectsSupported, JSON.stringify(badges)],
    );

    await client.query("COMMIT");
    inTransaction = false;

    logger.info(
      {
        event: "indexer_donation_recorded",
        amount,
        currency,
        project: projectId,
        donor: donorAddress,
        txHash,
      },
      "Indexer donation recorded",
    );

    // 5. Emit WebSocket event with currency field
    if (io) {
      io.emit("newDonation", {
        projectId,
        donorAddress,
        amountXLM: amountXlmForInsert, // null for USDC
        amount,
        currency,
        txHash,
        timestamp: new Date().toISOString(),
      });
    }

    // 6. Check milestones asynchronously
    checkAndDeliverMilestones(projectId).catch(() => {});
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK");
    logger.error(
      { event: "indexer_donation_error", project: projectId, txHash, err },
      err.message,
    );
  } finally {
    client.release();
  }
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
    timestamp: new Date().toISOString(),
  };
}

/**
 * Stop the indexer. Idempotent.
 */
async function stop() {
  try {
    if (horizonStream && typeof horizonStream.close === "function") {
      horizonStream.close();
    }
  } catch {
    // ignore
  } finally {
    horizonStream = null;
  }
  try {
    if (projectWalletsInterval) {
      clearInterval(projectWalletsInterval);
      projectWalletsInterval = null;
    }
  } catch {
    // ignore
  }
  isRunning = false;
}

module.exports = {
  startIndexer,
  getStatus,
  stop,
  // Exported for unit testing
  handleDonation,
  updateProjectWallets,
};
