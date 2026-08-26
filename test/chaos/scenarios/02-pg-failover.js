/**
 * test/chaos/scenarios/02-pg-failover.js
 *
 * Scenario 02 — PostgreSQL "primary failover" during donation recording.
 *
 * Fault: the host stops the Postgres container while a donation is being
 * recorded (docker compose stop postgres), then starts it again — the
 * single-node equivalent of a primary crash + failover.
 *
 * Assertions:
 *   - A donation attempted during the outage fails cleanly (no partial
 *     write, no crash of the process).
 *   - Re-submitting the ORIGINAL transaction hash after recovery is
 *     idempotent: the tx-hash dedup in recordDonation replays the existing
 *     record — no double-record, project totals unchanged.
 *   - The app's connection pool recovers on its own once Postgres is back.
 *
 * Host protocol: ready → faulted → during → recovered (see harness.js).
 */
"use strict";

const h = require("../lib/harness");

const PROJECT_ID = "22222222-2222-2222-2222-222222222222";

async function run() {
  const { recordDonation } = require("/backend/src/routes/donations");

  h.log("=== Scenario 02: PostgreSQL failover during donation recording ===");
  await h.resetDb();
  await h.seedProject(PROJECT_ID);

  const donor = h.makePublicKey("D");
  const txHash = h.makeTxHash("d");

  // Baseline: record the donation that we will later re-submit.
  const first = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "15",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert([200, 201].includes(first.statusCode), "baseline donation recorded");
  h.assert((await h.countDonations(PROJECT_ID)) === 1, "one donation row before failover");
  h.assert((await h.projectRaised(PROJECT_ID)) === 15, "raised_xlm = 15 before failover");

  // Signal the host to stop Postgres.
  h.writeMarker("02.ready");
  await h.waitForMarker("02.faulted");

  // ── During Postgres outage: donation fails cleanly, no partial state ────
  // The write path never starts (pool.connect() fails before any statement
  // runs), so no DB assertions are possible or needed while the database is
  // down — that is exactly what makes the outage safe: nothing was written.
  let threw = false;
  try {
    await h.invokeRecordDonation(recordDonation, {
      projectId: PROJECT_ID,
      donorAddress: h.makePublicKey("E"),
      amountXLM: "99",
      currency: "XLM",
      transactionHash: h.makeTxHash("e"),
    });
  } catch {
    threw = true;
  }
  h.assert(threw, "donation attempt during PG outage fails cleanly (no hang, no crash)");

  // Signal the host to restart Postgres.
  h.writeMarker("02.during");
  await h.waitForMarker("02.recovered");

  // ── Recovery: pool reconnects, idempotency holds ────────────────────────
  await h.waitFor(async () => {
    await h.pool.query("SELECT 1");
    return true;
  }, { timeoutMs: 60000, intervalMs: 1000, label: "Postgres to accept connections again" });

  // Re-submit the same tx hash → dedup replays the existing record.
  const replay = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: donor,
    amountXLM: "15",
    currency: "XLM",
    transactionHash: txHash,
  });
  h.assert(replay.statusCode === 200, "re-submitted tx hash returns the replay response (200)");
  h.assert(replay.body.success === true, "replay response is a success");
  h.assert((await h.countDonations(PROJECT_ID)) === 1, "no double-record after failover (still 1 row)");
  h.assert((await h.projectRaised(PROJECT_ID)) === 15, "no double-count in project totals (still 15)");

  // A brand-new donation works again.
  const fresh = await h.invokeRecordDonation(recordDonation, {
    projectId: PROJECT_ID,
    donorAddress: h.makePublicKey("F"),
    amountXLM: "5",
    currency: "XLM",
    transactionHash: h.makeTxHash("f"),
  });
  h.assert(fresh.statusCode === 201, "new donation records after recovery");
  h.assert((await h.countDonations(PROJECT_ID)) === 2, "two donation rows after recovery");
  h.assert((await h.projectRaised(PROJECT_ID)) === 20, "raised_xlm = 20 after recovery");
}

module.exports = { run };
