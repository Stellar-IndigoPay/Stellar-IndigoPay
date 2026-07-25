"use strict";

/**
 * src/services/recurringDonationWorker.js
 *
 * Periodically checks the IndigoPay contract's on-chain subscriptions
 * (see `create_subscription`/`get_subscription_by_index` in
 * `contracts/indigopay-contract/src/lib.rs`, issue #81) for ones that are
 * due, and notifies the donor — it never submits a donation transaction
 * itself. Per #81's scope, automation stops at "reminder + pre-built tx":
 * the donor still has to sign the actual `donate()` call in their wallet.
 *
 * Scheduling follows this codebase's existing convention (pg-boss cron,
 * same as retentionWorker.js / idempotencyCleanup.js) rather than a raw
 * setInterval, so it survives restarts and doesn't double-fire across
 * multiple backend replicas.
 *
 * There is no on-chain entrypoint that advances a subscription's
 * `next_execution` after it becomes due (see #81 scope notes) — the only
 * way `next_execution` moves is a fresh `create_subscription` call after
 * a `cancel_subscription`. So "don't re-notify for the same due tick every
 * 5 minutes" is necessarily tracked off-chain here, in memory, and resets
 * on process restart. That's an acceptable tradeoff for a notification
 * dedupe (worst case: one extra reminder after a restart), not a source
 * of truth for anything financial.
 */

const PgBoss = require("pg-boss");
const {
  Horizon,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  Asset,
  rpc,
} = require("@stellar/stellar-sdk");

const logger = require("../logger");
const {
  rpcServer,
  server: horizonServer,
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  simulateTransactionWithRetry,
  getOnChainProject,
} = require("./stellar");
const { enqueuePushNotification } = require("./pushQueue");

const QUEUE = "recurring-donation-check";
const DEFAULT_CRON = "*/5 * * * *"; // every 5 minutes, per issue #81
const DUMMY_SOURCE =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

let boss = null;

// De-dupe set, keyed by `${donor}:${projectId}:${next_execution}`. See the
// file-level comment above for why this can't be tracked on-chain.
const notifiedTicks = new Set();

// ---------------------------------------------------------------------------
// On-chain reads
// ---------------------------------------------------------------------------

/**
 * Reads `get_subscription_count()` from the contract — the number of
 * unique (donor, project_id) pairs that have ever had a subscription
 * (not a count of currently-active ones; see the contract's doc comment).
 *
 * @returns {Promise<number>}
 */
async function getSubscriptionCount() {
  if (!CONTRACT_ID) return 0;

  const contract = new Contract(CONTRACT_ID);
  const dummyAccount = new Horizon.Account(DUMMY_SOURCE, "-1");
  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_subscription_count"))
    .setTimeout(30)
    .build();

  const result = await simulateTransactionWithRetry(tx);
  if (rpc.Api.isSimulationSuccess(result)) {
    return Number(scValToNative(result.result.retval));
  }
  return 0;
}

/**
 * Reads `get_subscription_by_index(index)` from the contract.
 *
 * @param {number} index
 * @returns {Promise<object|null>} the Subscription struct as a plain
 *   object (donor, project_id, amount, interval_ledgers, next_execution,
 *   active, created_at), or null if the read failed.
 */
async function getSubscriptionByIndex(index) {
  if (!CONTRACT_ID) return null;

  const contract = new Contract(CONTRACT_ID);
  const dummyAccount = new Horizon.Account(DUMMY_SOURCE, "-1");
  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "get_subscription_by_index",
        nativeToScVal(index, { type: "u32" }),
      ),
    )
    .setTimeout(30)
    .build();

  const result = await simulateTransactionWithRetry(tx);
  if (rpc.Api.isSimulationSuccess(result)) {
    return scValToNative(result.result.retval);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Pre-built transaction template
// ---------------------------------------------------------------------------

/**
 * Builds an unsigned `donate()` transaction XDR for a due subscription, for
 * the donor's wallet to review and sign — this function never submits
 * anything. Subscriptions are XLM-only (see #81's "Out of Scope: USDC
 * recurring donations"), so the token is always the native XLM SAC.
 *
 * @param {{donor: string, projectId: string, amount: bigint|number}} args
 * @returns {Promise<string|null>} base64 transaction XDR, or null if a
 *   template couldn't be built (e.g. the donor account doesn't exist yet).
 */
async function buildDonationTemplate({ donor, projectId, amount }) {
  if (!CONTRACT_ID) return null;

  let sourceAccount;
  try {
    sourceAccount = await horizonServer.loadAccount(donor);
  } catch (err) {
    logger.warn(
      {
        event: "recurring_worker_load_account_failed",
        donor,
        err: err.message,
      },
      "[recurringDonationWorker] Could not load donor account to build a subscription tx template",
    );
    return null;
  }

  const tokenContractId = Asset.native().contractId(NETWORK_PASSPHRASE);
  const contract = new Contract(CONTRACT_ID);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: "1000000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "donate",
        nativeToScVal(tokenContractId, { type: "address" }),
        nativeToScVal(donor, { type: "address" }),
        nativeToScVal(projectId, { type: "string" }),
        nativeToScVal(amount, { type: "i128" }),
        nativeToScVal(0, { type: "u32" }),
      ),
    )
    .setTimeout(180)
    .build();

  return tx.toXDR();
}

// ---------------------------------------------------------------------------
// Worker tick
// ---------------------------------------------------------------------------

/**
 * One pass over every on-chain subscription: finds the ones that are due
 * and haven't already been notified for this `next_execution`, builds a
 * pre-built donation transaction template for each, and notifies the donor
 * via WebSocket (`recurring_due`) and the existing push queue
 * (`recurring_reminder`). Never submits a transaction.
 *
 * A failure reading one subscription (or building its template) is logged
 * and skipped — it never aborts the rest of the pass, matching this
 * codebase's convention for batch jobs (see retentionWorker.runAllPolicies).
 *
 * @param {import("socket.io").Server} [io]
 */
async function checkDueSubscriptions(io) {
  let latestLedger;
  try {
    const ledgerInfo = await rpcServer.getLatestLedger();
    latestLedger = ledgerInfo.sequence;
  } catch (err) {
    logger.error(
      { event: "recurring_worker_ledger_fetch_failed", err: err.message },
      "[recurringDonationWorker] Could not fetch latest ledger",
    );
    return;
  }

  let count;
  try {
    count = await getSubscriptionCount();
  } catch (err) {
    logger.error(
      { event: "recurring_worker_count_fetch_failed", err: err.message },
      "[recurringDonationWorker] Could not fetch subscription count",
    );
    return;
  }

  for (let i = 0; i < count; i++) {
    // eslint-disable-next-line no-await-in-loop
    await processSubscriptionAtIndex(i, latestLedger, io);
  }
}

async function processSubscriptionAtIndex(index, latestLedger, io) {
  let sub;
  try {
    sub = await getSubscriptionByIndex(index);
  } catch (err) {
    logger.warn(
      {
        event: "recurring_worker_index_fetch_failed",
        index,
        err: err.message,
      },
      `[recurringDonationWorker] Could not fetch subscription at index ${index}`,
    );
    return;
  }

  if (!sub || !sub.active) return;
  if (Number(sub.next_execution) > latestLedger) return;

  const dedupeKey = `${sub.donor}:${sub.project_id}:${sub.next_execution}`;
  if (notifiedTicks.has(dedupeKey)) return;
  notifiedTicks.add(dedupeKey);

  let prebuiltTransactionXDR = null;
  try {
    prebuiltTransactionXDR = await buildDonationTemplate({
      donor: sub.donor,
      projectId: sub.project_id,
      amount: sub.amount,
    });
  } catch (err) {
    logger.warn(
      {
        event: "recurring_worker_tx_build_failed",
        donor: sub.donor,
        projectId: sub.project_id,
        err: err.message,
      },
      "[recurringDonationWorker] Could not build donation transaction template",
    );
  }

  if (io) {
    io.emit("recurring_due", {
      donor: sub.donor,
      projectId: sub.project_id,
      amount: String(sub.amount),
      intervalLedgers: sub.interval_ledgers,
      nextExecution: sub.next_execution,
      prebuiltTransactionXDR,
    });
  }

  const project = await getOnChainProject(sub.project_id).catch(() => null);

  try {
    await enqueuePushNotification({
      type: "recurring_reminder",
      payload: {
        donorAddress: sub.donor,
        projectId: sub.project_id,
        projectName: project?.name || sub.project_id,
        amount: String(sub.amount),
        currency: "XLM",
        recurringId: dedupeKey,
      },
    });
  } catch (err) {
    // Push delivery is best-effort — the WebSocket event above already
    // notified any connected client; a push queue failure (e.g. it isn't
    // started in this process) shouldn't block other due subscriptions.
    logger.warn(
      {
        event: "recurring_worker_push_enqueue_failed",
        donor: sub.donor,
        projectId: sub.project_id,
        err: err.message,
      },
      "[recurringDonationWorker] Could not enqueue push reminder",
    );
  }

  logger.info(
    {
      event: "recurring_due_detected",
      donor: sub.donor,
      projectId: sub.project_id,
      nextExecution: sub.next_execution,
    },
    `[recurringDonationWorker] Subscription due: ${sub.donor} \u2192 ${sub.project_id}`,
  );
}

// ---------------------------------------------------------------------------
// pg-boss wiring
// ---------------------------------------------------------------------------

/**
 * Start the recurring-donation check scheduler.
 *
 * @param {import("socket.io").Server} [io] - passed through to
 *   checkDueSubscriptions so it can emit `recurring_due`, matching the
 *   `start(io)` convention used by profileQueue.js / summaryQueue.js.
 */
async function start(io) {
  const cronOverride = process.env.RECURRING_DONATION_CRON;
  if (cronOverride === "disabled") {
    logger.info(
      { event: "recurring_worker_disabled" },
      "[recurringDonationWorker] Disabled via env",
    );
    return;
  }

  const cronSchedule = cronOverride || DEFAULT_CRON;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "recurring_worker_pgboss_error", err: err.message },
      "[recurringDonationWorker] pg-boss error",
    ),
  );

  await boss.start();
  await boss.schedule(QUEUE, cronSchedule, {}, { tz: "UTC" });
  await boss.work(QUEUE, { teamSize: 1, teamConcurrency: 1 }, async () => {
    await checkDueSubscriptions(io);
  });

  logger.info(
    { event: "recurring_worker_scheduled", cron: cronSchedule },
    `[recurringDonationWorker] Scheduled: ${cronSchedule}`,
  );
}

/**
 * Gracefully stop the pg-boss instance so an in-flight check drains.
 */
async function stop() {
  if (!boss) return;
  try {
    await boss.stop({ graceful: true, timeout: 15_000 });
  } catch (err) {
    logger.warn(
      { event: "recurring_worker_stop_error", err: err.message },
      "[recurringDonationWorker] graceful stop failed",
    );
  }
  boss = null;
}

module.exports = {
  QUEUE,
  start,
  stop,
  checkDueSubscriptions,
  getSubscriptionCount,
  getSubscriptionByIndex,
  buildDonationTemplate,
  _notifiedTicks: notifiedTicks,
};
