/**
 * backend/src/services/indexerDonationHandler.js
 *
 * Shared donation processing logic used by both the SSE stream indexer
 * (indexerService.js) and the DLQ worker (indexerDLQWorker.js).
 *
 * Breaking this out avoids the circular dependency that would otherwise
 * exist when indexerService.js needs to call enqueue() and
 * indexerDLQWorker.js needs to call handleDonation().
 *
 * The function is exported as a standalone module so both consumers
 * can import it independently.
 */
"use strict";

const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const { computeBadges } = require("./store");
const { checkAndDeliverMilestones } = require("./webhook");
const { Counter } = require("prom-client");
const { registry } = require("./metrics");
const logger = require("../logger");

// Prometheus metric for tracking processed donations
const indexerDonationsProcessed = new Counter({
  name: "indexer_donations_processed_total",
  help: "Total number of donations processed by the indexer",
  labelNames: ["currency", "source"],
  registers: [registry],
});

// Global reference to the USDC→XLM rate — set by indexerService on startup
let usdcToXlmRate = 8.0;

/**
 * Set the USDC→XLM conversion rate. Called by indexerService during startup.
 * @param {number} rate
 */
function setUsdcToXlmRate(rate) {
  usdcToXlmRate = rate;
}

/**
 * Handle a payment to a project — supports both native XLM and USDC.
 *
 * @param {string} projectId - Internal project UUID.
 * @param {object} op        - Horizon operation object.
 * @param {{ isNative: boolean, isUSDC: boolean, isBackfill: boolean }} flags
 * @param {object} [options]
 * @param {function} [options.onCursorUpdate] - Optional callback to persist cursor
 *                                               (called inside the transaction).
 */
async function handleDonation(projectId, op, { isNative, isUSDC, isBackfill = false }, options = {}) {
  const txHash = op.transaction_hash;
  const donorAddress = op.from;
  const ledger = op.ledger_attr;

  let currency;
  let amount;
  let amountXlmForRaised;
  let amountXlmForInsert;

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
    amountXlmForInsert = null;
  } else {
    return;
  }

  if (isNaN(amount) || amount <= 0) return;

  const client = await pool.connect();
  let inTransaction = false;

  try {
    const existingResult = await client.query(
      "SELECT id FROM donations WHERE transaction_hash = $1",
      [txHash],
    );
    if (existingResult.rows.length > 0) {
      return;
    }

    await client.query("BEGIN");
    inTransaction = true;

    const donationId = uuid();
    await client.query(
      `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [donationId, projectId, donorAddress, amountXlmForInsert, amount, currency, txHash],
    );

    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1,
           donor_count = (SELECT COUNT(DISTINCT donor_address) FROM donations WHERE project_id = $2),
           updated_at = NOW()
       WHERE id = $2`,
      [amountXlmForRaised, projectId],
    );

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

    // Persist cursor if a callback was provided (atomic within the transaction)
    if (typeof options.onCursorUpdate === "function") {
      await options.onCursorUpdate(client, ledger);
    }

    await client.query("COMMIT");
    inTransaction = false;

    const source = isBackfill ? "backfill" : "stream";
    indexerDonationsProcessed.inc({ currency, source });

    logger.info(
      {
        event: "indexer_donation_recorded",
        amount,
        currency,
        source,
        project: projectId,
        donor: donorAddress,
        txHash,
        ledger,
      },
      `Indexer donation recorded (${source})`,
    );

    checkAndDeliverMilestones(projectId).catch(() => {});

    return { donationId, amount, currency, source };
  } catch (err) {
    if (inTransaction) await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  handleDonation,
  setUsdcToXlmRate,
};
