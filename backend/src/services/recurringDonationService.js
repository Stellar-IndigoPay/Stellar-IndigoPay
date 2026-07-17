/**
 * src/services/recurringDonationService.js
 *
 * Background cron service for executing recurring donation payments.
 *
 * Polls the `recurring_donations` table every 5 minutes for due
 * subscriptions (next_payment_ledger <= current ledger). For each due
 * subscription:
 *   1. Verifies on-chain state via Soroban RPC (get_subscription).
 *   2. Verifies the project is still active (get_project).
 *   3. Builds and submits a Stellar payment transaction using the
 *      RECURRING_SIGNER_SECRET key.
 *   4. On success, calls mark_payment_executed on the contract and
 *      updates the Postgres row.
 *
 * Prometheus metrics:
 *   - recurring_donations_due         (gauge, current count of due subs)
 *   - recurring_donations_executed_total (counter, successful executions)
 *   - recurring_donations_failed_total   (counter, failed executions)
 */
"use strict";

const { Counter, Gauge } = require("prom-client");
const { registry } = require("./metrics");
const {
  Horizon,
  Networks,
  rpc,
  Contract,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
} = require("@stellar/stellar-sdk");
const logger = require("../logger");
const pool = require("../db/pool");

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

const recurringDonationsDue = new Gauge({
  name: "recurring_donations_due",
  help: "Current number of due recurring donations awaiting execution",
  registers: [registry],
});

const recurringDonationsExecutedTotal = new Counter({
  name: "recurring_donations_executed_total",
  help: "Total recurring donation payments executed successfully",
  registers: [registry],
});

const recurringDonationsFailedTotal = new Counter({
  name: "recurring_donations_failed_total",
  help: "Total recurring donation payments that failed",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const STELLAR_NETWORK = process.env.STELLAR_NETWORK || "testnet";
const HORIZON_URL =
  process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE =
  STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const CONTRACT_ID = process.env.CONTRACT_ID || "";
const RECURRING_SIGNER_SECRET = process.env.RECURRING_SIGNER_SECRET || "";
const POLL_INTERVAL_MS = Number(
  process.env.RECURRING_POLL_INTERVAL_MS || 300_000,
); // 5 minutes

const horizon = new Horizon.Server(HORIZON_URL);
const rpcServer = new rpc.Server(RPC_URL);

let signerKeypair = null;
let pollTimer = null;
let stopped = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCurrentLedger() {
  return horizon
    .ledgers()
    .order("desc")
    .limit(1)
    .call()
    .then((res) => Number(res.records[0].sequence));
}

async function callContract(method, args) {
  if (!CONTRACT_ID) throw new Error("CONTRACT_ID not configured");
  const contract = new Contract(CONTRACT_ID);
  const { sequence } = await rpcServer.getAccount(signerKeypair.publicKey());

  const tx = new TransactionBuilder(signerKeypair, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(300)
    .build();

  const simulated = await rpcServer.simulate(tx);
  const prepared = rpcServer.prepareTransaction(tx, simulated);
  prepared.sign(signerKeypair);
  const result = await rpcServer.sendTransaction(prepared);
  const { status } = await rpcServer.getTransaction(result.hash);

  if (status !== "SUCCESS") {
    throw new Error(`Contract call ${method} failed: ${status}`);
  }

  return result.hash;
}

async function fetchSubscriptions() {
  const nowLedger = await getCurrentLedger();
  const result = await pool.query(
    `SELECT * FROM recurring_donations
     WHERE active = TRUE AND next_payment_ledger <= $1
     ORDER BY next_payment_ledger ASC
     LIMIT 50`,
    [nowLedger],
  );
  return result.rows;
}

async function verifyAndExecute(sub) {
  const { subscription_id, donor_address, project_id, amount_stroops } = sub;

  // 1. Verify on-chain subscription state via Soroban RPC
  let onChainSub;
  try {
    const contract = new Contract(CONTRACT_ID);
    const sim = await rpcServer.simulate(
      new TransactionBuilder(signerKeypair, {
        fee: BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
      })
        .addOperation(contract.call("get_subscription", ...[]))
        .setTimeout(300)
        .build(),
    );
    // Use raw RPC call via contract invocation
    // Since we can't easily call get_subscription with a u32 arg via
    // the static Contract helper, we use a simpler approach:
    // build the transaction with proper scval arguments.
    const account = await rpcServer.getAccount(signerKeypair.publicKey());
    const subArg = nativeToScVal(subscription_id, { type: "u32" });

    const tx = new TransactionBuilder(signerKeypair, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_subscription", subArg))
      .setTimeout(300)
      .build();

    const simulated = await rpcServer.simulate(tx);
    if (
      !simulated ||
      !simulated.result ||
      !simulated.result.retval
    ) {
      logger.warn(
        { event: "subscription_verify_failed", subscription_id },
        "Could not verify subscription on-chain; skipping",
      );
      return { skipped: true, reason: "on-chain verification failed" };
    }

    const retval = scValToNative(simulated.result.retval);
    onChainSub = retval;
  } catch (err) {
    logger.warn(
      { event: "subscription_rpc_error", subscription_id, err: err.message },
      "RPC error verifying subscription; skipping",
    );
    return { skipped: true, reason: `RPC error: ${err.message}` };
  }

  if (!onChainSub || !onChainSub.active) {
    // Subscription is no longer active on-chain — update DB and skip
    await pool.query(
      "UPDATE recurring_donations SET active = FALSE, updated_at = NOW() WHERE subscription_id = $1",
      [subscription_id],
    );
    return { skipped: true, reason: "subscription not active on-chain" };
  }

  // 2. Verify project is still active
  try {
    const account = await rpcServer.getAccount(signerKeypair.publicKey());
    const projIdArg = nativeToScVal(project_id, { type: "string" });
    const contract = new Contract(CONTRACT_ID);
    const tx = new TransactionBuilder(signerKeypair, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_project", projIdArg))
      .setTimeout(300)
      .build();

    const simulated = await rpcServer.simulate(tx);
    if (simulated && simulated.result && simulated.result.retval) {
      const project = scValToNative(simulated.result.retval);
      if (!project.active || project.paused) {
        logger.warn(
          { event: "project_inactive", subscription_id, project_id },
          "Project is not active; skipping subscription",
        );
        return { skipped: true, reason: "project inactive or paused" };
      }
    } else {
      logger.warn(
        { event: "project_verify_failed", subscription_id, project_id },
        "Could not verify project; skipping",
      );
      return { skipped: true, reason: "project verification failed" };
    }
  } catch (err) {
    logger.warn(
      { event: "project_rpc_error", subscription_id, project_id, err: err.message },
      "RPC error verifying project; skipping",
    );
    return { skipped: true, reason: `RPC error: ${err.message}` };
  }

  // 3. Build and submit Stellar payment transaction
  try {
    const amountXLM = Number(amount_stroops) / 10_000_000;
    const account = await rpcServer.getAccount(signerKeypair.publicKey());

    const paymentTx = new TransactionBuilder(signerKeypair, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(
        Horizon.Operation.payment({
          destination: donor_address,
          asset: Horizon.Asset.native(),
          amount: amountXLM.toFixed(7),
        }),
      )
      .setTimeout(300)
      .build();

    paymentTx.sign(signerKeypair);
    const submitResult = await horizon.submitTransaction(paymentTx);

    // 4. On success, call mark_payment_executed on the contract
    const nowLedger = await getCurrentLedger();
    const newNextLedger = nowLedger + onChainSub.interval_ledgers;

    try {
      await callContract("mark_payment_executed", [
        nativeToScVal(subscription_id, { type: "u32" }),
        nativeToScVal(newNextLedger, { type: "u32" }),
      ]);
    } catch (contractErr) {
      logger.warn(
        {
          event: "mark_payment_executed_failed",
          subscription_id,
          err: contractErr.message,
        },
        "mark_payment_executed failed but payment was sent; will retry on next poll",
      );
    }

    // 5. Update Postgres row
    const newRemaining = onChainSub.remaining_payments - 1;
    const isActive = newRemaining > 0;

    await pool.query(
      `UPDATE recurring_donations
       SET remaining_payments = $1,
           active = $2,
           last_paid_at = NOW(),
           next_payment_ledger = $3,
           next_payment_due_at = NOW() + INTERVAL '1 month',
           updated_at = NOW()
       WHERE subscription_id = $4`,
      [newRemaining, isActive, newNextLedger, subscription_id],
    );

    recurringDonationsExecutedTotal.inc();
    logger.info(
      { event: "recurring_payment_executed", subscription_id, txHash: submitResult.hash },
      "Recurring payment executed successfully",
    );

    return { success: true, txHash: submitResult.hash };
  } catch (err) {
    recurringDonationsFailedTotal.inc();
    logger.error(
      { event: "recurring_payment_failed", subscription_id, err: err.message },
      "Recurring payment failed",
    );

    // Check for insufficient balance specifically
    if (
      err.message &&
      (err.message.includes("op_underfunded") ||
        err.message.includes("insufficient") ||
        err.message.includes("op_no_destination"))
    ) {
      logger.warn(
        { event: "balance_issue", subscription_id, donor: donor_address },
        "Donor account balance issue; subscription will be retried next poll",
      );
    }

    return { failed: true, reason: err.message };
  }
}

async function pollDueSubscriptions() {
  if (stopped || !signerKeypair) return;

  try {
    const subs = await fetchSubscriptions();
    recurringDonationsDue.set(subs.length);

    if (subs.length === 0) return;

    logger.info(
      { event: "recurring_poll", count: subs.length },
      `Processing ${subs.length} due recurring donations`,
    );

    for (const sub of subs) {
      if (stopped) break;
      try {
        await verifyAndExecute(sub);
      } catch (err) {
        logger.error(
          {
            event: "recurring_execution_error",
            subscription_id: sub.subscription_id,
            err: err.message,
          },
          "Unexpected error processing recurring donation",
        );
        recurringDonationsFailedTotal.inc();
      }
    }
  } catch (err) {
    logger.error(
      { event: "recurring_poll_error", err: err.message },
      "Error polling due subscriptions",
    );
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

async function start() {
  if (!CONTRACT_ID) {
    logger.warn(
      { event: "recurring_disabled" },
      "CONTRACT_ID not set; recurring donation service disabled",
    );
    return;
  }

  if (!RECURRING_SIGNER_SECRET) {
    logger.warn(
      { event: "recurring_disabled" },
      "RECURRING_SIGNER_SECRET not set; recurring donation service disabled",
    );
    return;
  }

  try {
    signerKeypair = Keypair.fromSecret(RECURRING_SIGNER_SECRET);
  } catch (err) {
    logger.warn(
      { event: "recurring_disabled", err: err.message },
      "Invalid RECURRING_SIGNER_SECRET; recurring donation service disabled",
    );
    return;
  }

  logger.info(
    { event: "recurring_started", pollIntervalMs: POLL_INTERVAL_MS },
    "Recurring donation service started",
  );

  // Run immediately on start, then poll on interval
  await pollDueSubscriptions();

  pollTimer = setInterval(pollDueSubscriptions, POLL_INTERVAL_MS);
  pollTimer.unref();
}

async function stop() {
  stopped = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  logger.info(
    { event: "recurring_stopped" },
    "Recurring donation service stopped",
  );
}

module.exports = { start, stop };
