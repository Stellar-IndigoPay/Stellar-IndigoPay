/**
 * test/chaos/driver.js
 *
 * Chaos-suite driver. Runs inside the backend container (see
 * docker-compose.chaos.yml) as the container's main process. Executes the
 * four scenarios in order, writes a machine-readable summary to
 * /chaos-run/summary.json, and exits 0 only when every scenario passed.
 *
 * Scenarios 01-02 coordinate with the host (run-chaos.sh) via marker files
 * in /chaos-run so the host can crash/restart Redis and Postgres with
 * `docker compose stop|start`. Scenarios 03-04 inject faults themselves via
 * the chaos-stub's admin API.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const h = require("./lib/harness");

const scenarios = [
  { id: "01", name: "redis-crash", file: "./scenarios/01-redis-crash" },
  { id: "02", name: "pg-failover", file: "./scenarios/02-pg-failover" },
  { id: "03", name: "horizon-outage", file: "./scenarios/03-horizon-outage" },
  { id: "04", name: "soroban-timeout", file: "./scenarios/04-soroban-timeout" },
];

async function main() {
  h.log("chaos driver starting (chaos-run dir: " + h.RUN_DIR + ")");
  const results = [];
  let failed = false;

  for (const scenario of scenarios) {
    const startedAt = Date.now();
    h.log(`\n──────────────────────────────────────────────`);
    h.log(`▶ Scenario ${scenario.id} — ${scenario.name}`);
    h.log(`──────────────────────────────────────────────`);
    try {
      const mod = require(scenario.file);
      await mod.run();
      results.push({ id: scenario.id, name: scenario.name, status: "PASS", durationMs: Date.now() - startedAt });
      h.log(`✅ Scenario ${scenario.id} (${scenario.name}) PASSED in ${Date.now() - startedAt}ms`);
    } catch (err) {
      failed = true;
      results.push({ id: scenario.id, name: scenario.name, status: "FAIL", durationMs: Date.now() - startedAt, error: err.message });
      h.log(`❌ Scenario ${scenario.id} (${scenario.name}) FAILED: ${err.message}`);
    } finally {
      h.writeMarker(scenario.id + ".done");
    }
  }

  h.log(`\n──────────────────────────────────────────────`);
  h.log(`SUMMARY`);
  h.log(`──────────────────────────────────────────────`);
  for (const r of results) {
    h.log(`${r.status === "PASS" ? "✅" : "❌"} [${r.id}] ${r.name} — ${r.status} (${r.durationMs}ms)${r.error ? ` — ${r.error}` : ""}`);
  }
  h.log(failed ? "❌ CHAOS SUITE FAILED" : "✅ ALL CHAOS SCENARIOS PASSED");

  // Machine-readable summary for the nightly CI dashboard/artifact.
  fs.mkdirSync(h.RUN_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(h.RUN_DIR, "summary.json"),
    JSON.stringify({ suite: "chaos", ranAt: new Date().toISOString(), passed: !failed, results }, null, 2),
  );

  await h.pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("[chaos] FATAL driver error:", err);
  process.exit(1);
});
