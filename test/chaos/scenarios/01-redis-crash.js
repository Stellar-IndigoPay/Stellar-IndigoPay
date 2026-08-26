/**
 * test/chaos/scenarios/01-redis-crash.js
 *
 * Scenario 01 — Redis crash during a donation spike.
 *
 * Fault: the host stops the Redis container mid-spike (docker compose stop
 * redis), simulating a Redis crash.
 *
 * Assertions:
 *   - Donations keep being recorded to Postgres during the outage (no data
 *     loss): the app's cache layer (redis.get/set) degrades to a no-op and
 *     every recordDonation still succeeds.
 *   - Cache reads return null during the outage instead of throwing
 *     (graceful cache degradation).
 *   - After Redis is restarted the cache works again and the donation count
 *     is exactly what was submitted (no loss, no duplication).
 *
 * Host protocol: ready → faulted → during → recovered (see harness.js).
 */
"use strict";

const h = require("../lib/harness");

const PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const SPIKE_DURING_FAULT = 5;
const SPIKE_BEFORE_FAULT = 5;

async function run() {
  const { recordDonation } = require("/backend/src/routes/donations");

  h.log("=== Scenario 01: Redis crash during donation spike ===");
  await h.resetDb();
  await h.seedProject(PROJECT_ID);

  // Baseline: cache works. (Wait for the lazy ioredis connection first.)
  await h.waitForRedis();
  await h.redis.set("chaos:probe", { v: 1 });
  const baseline = await h.redis.get("chaos:probe");
  h.assert(baseline && baseline.v === 1, "Redis baseline read/write works");

  // ── Pre-fault donation spike ────────────────────────────────────────────
  for (let i = 0; i < SPIKE_BEFORE_FAULT; i++) {
    const res = await h.invokeRecordDonation(recordDonation, {
      projectId: PROJECT_ID,
      donorAddress: h.makePublicKey(String.fromCharCode(65 + i)),
      amountXLM: "10",
      currency: "XLM",
      transactionHash: h.makeTxHash(i),
    });
    h.assert([200, 201].includes(res.statusCode), `pre-fault donation ${i} recorded`);
  }
  h.assert((await h.countDonations(PROJECT_ID)) === SPIKE_BEFORE_FAULT, `pre-fault count = ${SPIKE_BEFORE_FAULT}`);

  // Signal the host to crash Redis, then wait for it to take effect.
  h.writeMarker("01.ready");
  await h.waitForMarker("01.faulted");

  // ── During Redis outage: cache degrades, donations still persist ───────
  const degraded = await h.redis.get("chaos:probe");
  h.assert(degraded === null, "cache read degrades to null during Redis outage (no throw)");

  for (let i = 0; i < SPIKE_DURING_FAULT; i++) {
    const res = await h.invokeRecordDonation(recordDonation, {
      projectId: PROJECT_ID,
      donorAddress: h.makePublicKey(String.fromCharCode(70 + i)),
      amountXLM: "10",
      currency: "XLM",
      transactionHash: h.makeTxHash(SPIKE_BEFORE_FAULT + i),
    });
    h.assert([200, 201].includes(res.statusCode), `during-fault donation ${i} recorded (no data loss)`);
  }
  const duringCount = await h.countDonations(PROJECT_ID);
  h.assert(duringCount === SPIKE_BEFORE_FAULT + SPIKE_DURING_FAULT, `donations persisted during outage (count=${duringCount})`);
  h.assert((await h.projectRaised(PROJECT_ID)) === (SPIKE_BEFORE_FAULT + SPIKE_DURING_FAULT) * 10, "project raised_xlm matches donations (no data loss)");

  // Signal the host to restart Redis.
  h.writeMarker("01.during");
  await h.waitForMarker("01.recovered");

  // ── Recovery: cache restored, totals intact ─────────────────────────────
  // ioredis reconnects asynchronously after the server comes back — poll by
  // writing a NEW key and reading it back. This environment runs Redis
  // WITHOUT persistence (default no-persistence config), so a key written
  // before the crash is not guaranteed to survive the restart; requiring it
  // would test Redis durability, not recovery. A fresh write/read proves the
  // cache is genuinely operational again.
  await h.waitFor(async () => {
    await h.redis.set("chaos:recovery-probe", { v: Date.now() });
    const restored = await h.redis.get("chaos:recovery-probe");
    return restored !== null && typeof restored.v === "number";
  }, { timeoutMs: 30000, intervalMs: 500, label: "Redis to accept new writes after restart" });
  h.assert(true, "cache accepts new writes after Redis restart (recovered)");
  const finalCount = await h.countDonations(PROJECT_ID);
  h.assert(finalCount === SPIKE_BEFORE_FAULT + SPIKE_DURING_FAULT, `no donation lost or duplicated after recovery (count=${finalCount})`);
  h.assert((await h.projectRaised(PROJECT_ID)) === (SPIKE_BEFORE_FAULT + SPIKE_DURING_FAULT) * 10, "project totals unchanged after recovery");
}

module.exports = { run };
