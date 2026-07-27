"use strict";

/**
 * Performance test: benchmark a full projection rebuild over 100,000 synthetic
 * donation events and assert it completes under the 30s target.
 *
 * Uses testcontainers (real Postgres). Skipped gracefully when Docker is
 * unavailable — the benchmark result is logged so it can be captured in CI.
 *
 * Run with: INTEGRATION=1 npm test -- projectionEngine.performance
 *
 * Target: rebuildAllProjections over 100k events < 30s (acceptance criteria).
 */

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const fs = require("fs");
const path = require("path");
const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const { insertEvent, rebuildAllProjections } = require("./projectionEngine");

const EVENT_COUNT = Number(process.env.PERF_EVENT_COUNT || 100000);
const TARGET_MS = Number(process.env.PERF_TARGET_MS || 30000);

let container;
let testPool;
let ready = false;

const DONORS = Array.from({ length: 200 }, (_, i) => `G${i}`.padEnd(56, "A"));
const PROJECTS = Array.from({ length: 50 }, (_, i) => `p-${i}`.padEnd(36, "0"));

describe("Projection engine performance (100k event rebuild)", () => {
  jest.setTimeout(300000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping performance (SKIP_INTEGRATION=1)");
      return;
    }
    try {
      container = await new GenericContainer("postgres:15-alpine")
        .withEnvironment({
          POSTGRES_USER: "test",
          POSTGRES_PASSWORD: "test",
          POSTGRES_DB: "indigopay_test",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(
          Wait.forLogMessage("database system is ready to accept connections", 2),
        )
        .withStartupTimeout(120000)
        .start();

      const host = container.getHost();
      const port = container.getMappedPort(5432);
      testPool = new Pool({
        connectionString: `postgres://test:test@${host}:${port}/indigopay_test`,
        max: 10,
      });

      const schemaSql = fs.readFileSync(
        path.join(__dirname, "..", "db", "schema.sql"),
        "utf8",
      );
      await testPool.query(schemaSql);
      for (const p of PROJECTS) {
        await testPool.query(
          `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, co2_offset_kg, status)
           VALUES ($1, 'p', 'd', 'Reforestation', 'l', 'G'.repeat(56), 0, 0, 0, 0, 'active')
           ON CONFLICT (id) DO NOTHING`,
          [p],
        );
      }
      ready = true;
      console.log("Performance container ready");
    } catch (err) {
      console.warn("Performance test skipped:", err.message);
      ready = false;
      try { if (testPool) await testPool.end(); } catch { /* noop */ }
      try { if (container) await container.stop(); } catch { /* noop */ }
      container = null;
      testPool = null;
    }
  });

  afterAll(async () => {
    try { if (testPool) await testPool.end(); } catch { /* noop */ }
    try { if (container) await container.stop({ timeout: 5000 }); } catch { /* noop */ }
  });

  test(`rebuild of ${EVENT_COUNT} events completes under ${TARGET_MS}ms`, async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    await testPool.query("TRUNCATE donation_events");

    // Seed synthetic events directly into the event store.
    const seedStart = Date.now();
    for (let i = 0; i < EVENT_COUNT; i++) {
      const donor = DONORS[i % DONORS.length];
      const project = PROJECTS[i % PROJECTS.length];
      const amount = 1 + (i % 1000);
      await insertEvent({
        event_type: "DonationRecorded",
        aggregate_id: project,
        event_data: {
          donorAddress: donor, projectId: project, amountXLM: amount,
          currency: "XLM", co2OffsetKg: amount * 10, projectsSupported: 1,
          transactionHash: `perf-tx-${i}`,
        },
        transaction_hash: `perf-tx-${i}`,
      }, testPool);
    }
    console.log(`Seeded ${EVENT_COUNT} events in ${Date.now() - seedStart}ms`);

    const result = await rebuildAllProjections({ pool: testPool });
    console.log(`Rebuild of ${result.events} events took ${result.durationMs}ms (target ${TARGET_MS}ms)`);

    expect(result.events).toBe(EVENT_COUNT);
    expect(result.durationMs).toBeLessThan(TARGET_MS);
  });
});
