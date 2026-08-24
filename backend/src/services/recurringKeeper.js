/**
 * src/services/recurringKeeper.js
 *
 * Recurring Donation Keeper Service.
 *
 * Periodically queries the database for matured recurring donation schedules,
 * builds, simulates, signs, and submits the execute_recurring transactions on-chain.
 */
"use strict";

const pool = require("../db/pool");
const logger = require("../logger");
const {
  server: stellarServer,
  NETWORK_PASSPHRASE,
  submitTransaction,
  simulateTransactionWithRetry,
} = require("./stellar");
const {
  Contract,
  Address,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} = require("@stellar/stellar-sdk");
const { metrics } = require("./metrics");
const { getSigningSecret } = require("./signingSecretProvider");
const { withAdvisoryLock, LOCK_KEYS } = require("./advisoryLock");
const { createDrainController } = require("./workerLifecycle");

let intervalId = null;
let isExecuting = false;

// Tracks whether a keeper cycle is currently in flight so `stop()` can
// wait for it to finish (or release control after its grace period)
// instead of returning immediately while a cycle is still submitting
// on-chain transactions — see issue #931.
const drain = createDrainController("recurring_keeper");

/**
 * Start the recurring donation keeper loop.
 */
async function start() {
  if (intervalId) return;

  // Run initial cycle
  drain.trackJob(() => runKeeperCycleWithLock()).catch((err) => {
    logger.error({ event: "recurring_keeper_initial_error", err: err.message }, "Error in initial keeper cycle");
  });

  // Check every 60 seconds
  intervalId = setInterval(async () => {
    if (isExecuting || drain.isDraining()) {
      logger.debug({ event: "recurring_keeper_skip_overlap" }, "Previous keeper cycle still running, or worker draining; skipping this tick");
      return;
    }
    isExecuting = true;
    try {
      await drain.trackJob(() => runKeeperCycleWithLock());
    } catch (err) {
      logger.error({ event: "recurring_keeper_cycle_error", err: err.message }, "Error during keeper cycle");
    } finally {
      isExecuting = false;
    }
  }, 60_000);
}

/**
 * Stop the recurring donation keeper loop.
 *
 * Stops scheduling new cycles immediately, then waits (up to the drain
 * grace period) for any cycle currently in flight to finish submitting
 * its on-chain transactions, so a SIGTERM never truncates a keeper cycle
 * mid-submission.
 */
async function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  await drain.beginDrain();
}

/**
 * Main keeper cycle, guarded by a per-worker Postgres advisory lock so only
 * one replica executes a given cycle at a time (issue #677).
 */
async function runKeeperCycleWithLock() {
  return withAdvisoryLock(LOCK_KEYS.recurringKeeper, runKeeperCycle);
}

/**
 * Main keeper cycle logic.
 */
async function runKeeperCycle() {
  let keeperSecret;
  try {
    keeperSecret = await getSigningSecret("recurringKeeper");
  } catch (err) {
    logger.warn({ event: "recurring_keeper_no_secret", err: err.message }, "Recurring keeper managed signing secret not configured, skipping recurring donation keeper cycle");
    return;
  }
  const contractId = process.env.CONTRACT_ID;
  if (!contractId) {
    logger.warn({ event: "recurring_keeper_no_contract" }, "CONTRACT_ID not configured, skipping recurring donation keeper cycle");
    return;
  }

  const keypair = Keypair.fromSecret(keeperSecret);
  const keeperPublicKey = keypair.publicKey();

  // Fetch pending schedules due for execution
  const dueSchedules = await fetchDueSchedules();

  // Update Prometheus pending gauge
  if (metrics.recurringPending) {
    metrics.recurringPending.set(dueSchedules.length);
  }

  if (dueSchedules.length === 0) {
    logger.debug({ event: "recurring_keeper_no_due_schedules" }, "No recurring donations due for execution");
    return;
  }

  logger.info(
    { event: "recurring_keeper_due_found", count: dueSchedules.length },
    `Found ${dueSchedules.length} recurring donations due for execution`
  );

  let account;
  try {
    account = await stellarServer.loadAccount(keeperPublicKey);
  } catch (err) {
    logger.error({ event: "recurring_keeper_load_account_failed", err: err.message }, "Failed to load keeper account from Stellar network");
    return;
  }

  // Process each schedule sequentially to prevent transaction sequence conflicts.
  // The keeper account is re-fetched before every submission: a single loaded
  // account can go stale if its sequence advances between submissions (e.g. an
  // external transaction or a failed attempt), causing later submissions to fail
  // with tx_bad_seq.
  for (const schedule of dueSchedules) {
    try {
      account = await stellarServer.loadAccount(keeperPublicKey);
      await executeSchedule(schedule, account, keypair);
      if (metrics.recurringExecutionsTotal) {
        metrics.recurringExecutionsTotal.inc({ status: "success" });
      }
    } catch (err) {
      logger.error(
        {
          event: "recurring_keeper_schedule_failed",
          donor: schedule.donor_address,
          recurringId: schedule.recurring_id,
          projectId: schedule.project_id,
          err: err.message,
        },
        `Failed to execute recurring donation schedule for donor ${schedule.donor_address} (ID: ${schedule.recurring_id})`
      );
      if (metrics.recurringExecutionsTotal) {
        metrics.recurringExecutionsTotal.inc({ status: "failed" });
      }
    }
  }
}

/**
 * Fetch due schedules from database.
 */
async function fetchDueSchedules() {
  const result = await pool.query(
    `SELECT donor_address, recurring_id, project_id, amount, currency, keeper_incentive 
     FROM recurring_donations 
     WHERE active = TRUE AND next_execution_at <= NOW()
     ORDER BY next_execution_at ASC`
  );
  return result.rows;
}

/**
 * Execute a single recurring donation on-chain.
 */
async function executeSchedule(schedule, account, keypair) {
  const contractId = process.env.CONTRACT_ID;
  const contract = new Contract(contractId);
  
  const tx = new TransactionBuilder(account, {
    fee: "100000", // High starting fee for simulation
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "execute_recurring",
        Address.fromString(keypair.publicKey()).toScVal(),
        Address.fromString(schedule.donor_address).toScVal(),
        nativeToScVal(schedule.recurring_id, { type: "u32" })
      )
    )
    .setTimeout(30)
    .build();

  const sim = await simulateTransactionWithRetry(tx);
  if (!rpc.Api.isSimulationSuccess(sim)) {
    throw new Error(`Simulation failed: ${JSON.stringify(sim.error || sim.result?.retval || "unknown error")}`);
  }

  const preparedTx = rpc.assembleTransaction(tx, sim).build();
  
  preparedTx.sign(keypair);
  const xdrString = preparedTx.toXDR();
  
  const submitResult = await submitTransaction(xdrString);

  logger.info(
    {
      event: "recurring_keeper_execution_submitted",
      donor: schedule.donor_address,
      recurringId: schedule.recurring_id,
      txHash: submitResult.hash,
    },
    `Recurring donation executed successfully on-chain (txHash: ${submitResult.hash})`
  );
}

module.exports = {
  start,
  stop,
  runKeeperCycle,
  runKeeperCycleWithLock,
};
