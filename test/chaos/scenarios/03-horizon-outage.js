/**
 * test/chaos/scenarios/03-horizon-outage.js
 *
 * Scenario 03 — Stellar Horizon unavailability (HTTP 503) during donation
 * recording and the recurring keeper cycle.
 *
 * Fault: the chaos-stub answers every /horizon/* request with HTTP 503 (and
 * the Soroban RPC with 503 for the retry/circuit-breaker assertions).
 *
 * Assertions:
 *   - A donation recorded during the outage fails cleanly (TX_NOT_FOUND
 *     path) with zero partial writes — no fake data ever lands in Postgres.
 *   - The recurring keeper cycle degrades gracefully: loadAccount fails, the
 *     cycle aborts BEFORE touching schedules, and the due schedule is
 *     preserved for the next cycle — no data loss.
 *   - Soroban RPC retry + exponential backoff + circuit breaker: the real
 *     `withRetry` wrapper retries transient 503s (counter increments) and
 *     the shared `rpcBreaker` opens after the failure threshold.
 *   - Recovery: the same donation records successfully once Horizon is back
 *     (eventual recording), re-submitting it does NOT double-record, the
 *     breaker half-opens and returns to CLOSED, and the keeper schedule is
 *     still intact.
 *
 * Fully self-contained: no host-side fault injection required.
 */
"use strict";

const h = require("../lib/harness");

const PROJECT_ID = "33333333-3333-3333-3333-333333333333";
const SCHEDULE_ID = 33;

async function run() {
  const { rpc } = require("@stellar/stellar-sdk");

  // App modules (mounted at /backend/src in the container).
  const { recordDonation } = require("/backend/src/routes/donations");
  const stellar = require("/backend/src/services/stellar");
  const recurringKeeper = require("/backend/src/services/recurringKeeper");
  const { withRetry, rpcBreaker, sorobanRpcRetriesTotal } = stellar;

  // Pull the breaker's real reset timeout from the app config so the test
  // never drifts from backend/src/services/stellar.js if it changes.
  const BREAKER_RESET_TIMEOUT_MS = rpcBreaker.resetTimeout;
  const BREAKER_RECOVERY_WAIT_MS = BREAKER_RESET_TIMEOUT_MS + 15000;

  // A stub-bound Soroban RPC client (the app's own rpcServer stays https).
  // `withRetry` from the app routes every attempt through the SHARED
  // `rpcBreaker`, which is exactly the resilience path under test.
  const stubRpc = new rpc.Server(`${h.STUB_URL}/soroban`, { allowHttp: true });

  h.log("=== Scenario 03: Horizon 503 during donations + recurring keeper cycle ===");
  await h.resetDb();
  await h.seedProject(PROJECT_ID);

  const donor = h.makePublicKey("G");
  const txHash = h.makeTxHash("1");
  const keeperScheduleDonor = h.makePublicKey("K");
  await h.seedRecurringSchedule({ recurringId: SCHEDULE_ID, donorAddress: keeperScheduleDonor, projectId: PROJECT_ID });

  const scheduleBefore = await h.getSchedule(SCHEDULE_ID);
  h.assert(scheduleBefore && scheduleBefore.active === true, "due recurring schedule seeded");

  // ── Inject faults ────────────────────────────────────────────────────────
  await h.setFault("horizon", "503");
  await h.setFault("soroban", "503");

  // ── Donation during Horizon outage: clean failure, zero partial state ────
  let threw = false;
  try {
    await h.invokeRecordDonation(recordDonation, {
      projectId: PROJECT_ID,
      donorAddress: donor,
      amountXLM: "42",
      currency: "XLM",
      transactionHash: txHash,
    });
  } catch {
    threw = true;
  }
  h.assert(threw, "donation fails cleanly while Horizon is down (no fake data recorded)");
  h.assert((await h.countDonations(PROJECT_ID)) === 0, "no donation row written during outage");
  h.assert((await h.projectRaised(PROJECT_ID)) === 0, "project totals unchanged during outage");

  // ── Recurring keeper cycle during Horizon outage ─────────────────────────
  const statsBefore = await h.stubStats();
  await recurringKeeper.runKeeperCycle(); // must not throw
  const statsAfter = await h.stubStats();
  h.assert(statsAfter.horizonRequests > statsBefore.horizonRequests, "keeper cycle reached Horizon (loadAccount attempted)");
  const scheduleDuring = await h.getSchedule(SCHEDULE_ID);
  h.assert(
    scheduleDuring &&
      scheduleDuring.active === true &&
      new Date(scheduleDuring.next_execution_at).getTime() === new Date(scheduleBefore.next_execution_at).getTime(),
    "keeper cycle preserved the due schedule (retried next cycle — no data loss)",
  );

  // ── Soroban RPC retry + backoff + circuit breaker ────────────────────────
  const retriesBefore = await h.metricValue(sorobanRpcRetriesTotal);
  let attempts = 0;
  for (; attempts < 8; attempts++) {
    try {
      await withRetry(() => stubRpc.getLatestLedger());
    } catch {
      // expected while faulted
    }
    if (rpcBreaker.getState() === "open") break;
  }
  h.assert(rpcBreaker.getState() === "open", `circuit breaker OPEN after ${attempts + 1} attempt(s) of sustained 503s`);
  const retriesAfter = await h.metricValue(sorobanRpcRetriesTotal);
  h.assert(
    retriesAfter > retriesBefore,
    `Soroban RPC retried with backoff (retries total ${retriesBefore} → ${retriesAfter})`,
  );

  // ── Recovery ─────────────────────────────────────────────────────────────
  await h.clearFault("horizon");
  await h.clearFault("soroban");

  // Eventual recording: the same donation now succeeds.
  const recorded = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "42",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert(recorded.statusCode === 201, "donation eventually recorded after Horizon recovery");
  h.assert((await h.countDonations(PROJECT_ID)) === 1, "exactly one row for the donation");

  // Re-submission must not double-record.
  const replay = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "42",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert(replay.statusCode === 200 && replay.body.success === true, "re-submission replays the record (no double-record)");
  h.assert((await h.countDonations(PROJECT_ID)) === 1, "still exactly one row after replay");
  h.assert((await h.projectRaised(PROJECT_ID)) === 42, "project raised_xlm counted once (42)");

  // Circuit breaker recovers: after the reset timeout the next call is
  // tried in HALF_OPEN and, on success, the breaker returns to CLOSED.
  await h.waitFor(async () => {
    try {
      const ledger = await withRetry(() => stubRpc.getLatestLedger());
      return ledger && typeof ledger.sequence === "number" && rpcBreaker.getState() === "closed";
    } catch {
      return false;
    }
  }, { timeoutMs: BREAKER_RECOVERY_WAIT_MS, intervalMs: 2000, label: "circuit breaker to recover to CLOSED" });
  h.assert(rpcBreaker.getState() === "closed", "circuit breaker recovered to CLOSED after outage");

  // Keeper schedule still intact after everything.
  const scheduleAfter = await h.getSchedule(SCHEDULE_ID);
  h.assert(scheduleAfter && scheduleAfter.active === true, "keeper schedule preserved through the whole scenario");
}

module.exports = { run };
