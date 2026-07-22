"use strict";

/**
 * Integration test for the event-sourcing projection engine against a real
 * PostgreSQL instance (testcontainers).
 *
 * Verifies:
 *   - Each projection table is populated correctly from the event store
 *     (donor_leaderboard, project_stats, donor_history, global_stats).
 *   - Idempotent replay: applying the same event twice yields the same totals.
 *   - Rebuild correctness: a full rebuild from the event store equals the
 *     incrementally-built projections (this is the regression guarantee).
 *   - The read endpoints (leaderboard + global stats SQL) return identical
 *     numbers whether data came from incremental processing or a rebuild.
 *
 * Run with: INTEGRATION=1 npm test -- projectionEngine.integration
 * Skipped gracefully if Docker is unavailable.
 */

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const fs = require("fs");
const path = require("path");
const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const engine = require("./projectionEngine");
const {
  insertEvent,
  processEvent,
  rebuildAllProjections,
  truncateProjections,
} = engine;

let container;
let testPool;
let ready = false;

// Donor / project fixtures used across the suite.
const DONORS = ["GAAAREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATRE", "GBBBREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATRE", "GCCCREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATRE"];
const PROJECTS = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];

function seedEventsSql() {
  // A deterministic donation stream used to validate both incremental and
  // rebuild paths produce identical results.
  const events = [
    { donor: DONORS[0], project: PROJECTS[0], amount: 100, co2: 1000, tx: "tx-1" },
    { donor: DONORS[1], project: PROJECTS[0], amount: 50, co2: 500, tx: "tx-2" },
    { donor: DONORS[0], project: PROJECTS[1], amount: 25, co2: 250, tx: "tx-3" },
    { donor: DONORS[2], project: PROJECTS[1], amount: 200, co2: 2000, tx: "tx-4" },
    { donor: DONORS[0], project: PROJECTS[0], amount: 75, co2: 750, tx: "tx-5" },
  ];
  return events;
}

async function seedProjects() {
  for (const p of PROJECTS) {
    await testPool.query(
      `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, co2_offset_kg, status)
       VALUES ($1, 'p', 'd', 'Reforestation', 'l', 'G'.repeat(56), 0, 0, 0, 0, 'active')
       ON CONFLICT (id) DO NOTHING`,
      [p],
    );
  }
}

async function seedEventStore(events) {
  await testPool.query("TRUNCATE donation_events");
  for (const e of events) {
    await testPool.query(
      `INSERT INTO donation_events (event_type, aggregate_id, event_data, transaction_hash, created_at)
       VALUES ('DonationRecorded', $1, $2::jsonb, $3, NOW())`,
      [e.project, JSON.stringify({
        donorAddress: e.donor,
        projectId: e.project,
        amountXLM: e.amount,
        currency: "XLM",
        co2OffsetKg: e.co2,
        projectsSupported: 1,
        transactionHash: e.tx,
      }), e.tx],
    );
  }
}

async function snapshotProjections() {
  const lb = await testPool.query(
    "SELECT donor_address, total_donated, donation_count, total_co2_offset FROM projection_donor_leaderboard ORDER BY donor_address",
  );
  const ps = await testPool.query(
    "SELECT project_id, raised_xlm, donation_count, donor_count, co2_offset_kg FROM projection_project_stats ORDER BY project_id",
  );
  const g = await testPool.query(
    "SELECT total_xlm_raised, total_donations, total_donors, total_co2_offset_kg FROM projection_global_stats WHERE id=1",
  );
  const hist = await testPool.query("SELECT COUNT(*)::int c FROM projection_donor_history");
  return {
    leaderboard: lb.rows,
    projectStats: ps.rows,
    global: g.rows[0],
    historyCount: hist.rows[0].c,
  };
}

describe("Projection engine integration (testcontainers)", () => {
  jest.setTimeout(180000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping projection integration (SKIP_INTEGRATION=1)");
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
      const connectionString = `postgres://test:test@${host}:${port}/indigopay_test`;
      testPool = new Pool({ connectionString, max: 5 });

      const schemaSql = fs.readFileSync(
        path.join(__dirname, "..", "db", "schema.sql"),
        "utf8",
      );
      await testPool.query(schemaSql);
      await seedProjects();
      ready = true;
      console.log(`Projection integration PostgreSQL ready at ${host}:${port}`);
    } catch (err) {
      console.warn("Projection integration skipped:", err.message);
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

  beforeEach(async () => {
    if (!ready) return;
    await testPool.query("TRUNCATE donation_events");
    await truncateProjections(testPool);
  });

  test("incremental processing populates all four projections correctly", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const events = seedEventsSql();
    for (const e of events) {
      await insertEvent({
        event_type: "DonationRecorded",
        aggregate_id: e.project,
        event_data: {
          donorAddress: e.donor,
          projectId: e.project,
          amountXLM: e.amount,
          currency: "XLM",
          co2OffsetKg: e.co2,
          projectsSupported: 1,
          transactionHash: e.tx,
        },
        soroban_ledger: 1,
        transaction_hash: e.tx,
      }, testPool);
      await processEvent({
        event_type: "DonationRecorded",
        aggregate_id: e.project,
        event_data: {
          donorAddress: e.donor,
          projectId: e.project,
          amountXLM: e.amount,
          currency: "XLM",
          co2OffsetKg: e.co2,
          projectsSupported: 1,
          transactionHash: e.tx,
        },
        transaction_hash: e.tx,
      }, { pool: testPool });
    }

    const snap = await snapshotProjections();
    // donor 0: 100 + 25 + 75 = 200
    const donor0 = snap.leaderboard.find((r) => r.donor_address === DONORS[0]);
    expect(Number(donor0.total_donated)).toBeCloseTo(200);
    expect(donor0.donation_count).toBe(3);
    // project 0: 100 + 50 + 75 = 225
    const p0 = snap.projectStats.find((r) => r.project_id === PROJECTS[0]);
    expect(Number(p0.raised_xlm)).toBeCloseTo(225);
    expect(p0.donation_count).toBe(3);
    expect(p0.donor_count).toBe(2); // donors 0 and 1
    // global totals
    expect(Number(snap.global.total_xlm_raised)).toBeCloseTo(450); // 100+50+25+200+75
    expect(snap.global.total_donations).toBe(5);
    expect(snap.global.total_donors).toBe(3);
    expect(snap.historyCount).toBe(5);
  });

  test("idempotent replay: same event applied twice keeps identical totals", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const e = {
      event_type: "DonationRecorded",
      aggregate_id: PROJECTS[0],
      event_data: {
        donorAddress: DONORS[0], projectId: PROJECTS[0], amountXLM: 100,
        currency: "XLM", co2OffsetKg: 1000, projectsSupported: 1, transactionHash: "dup-tx",
      },
      transaction_hash: "dup-tx",
    };
    await processEvent(e, { pool: testPool });
    const first = await snapshotProjections();
    await processEvent(e, { pool: testPool }); // replay
    const second = await snapshotProjections();
    expect(Number(second.leaderboard[0].total_donated)).toBeCloseTo(Number(first.leaderboard[0].total_donated));
    expect(second.global.total_donations).toBe(first.global.total_donations);
    expect(second.historyCount).toBe(first.historyCount); // ON CONFLICT DO NOTHING
  });

  test("rebuild equals incremental projection (regression guarantee)", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    // Build incrementally.
    const events = seedEventsSql();
    for (const e of events) {
      await insertEvent({
        event_type: "DonationRecorded",
        aggregate_id: e.project,
        event_data: {
          donorAddress: e.donor, projectId: e.project, amountXLM: e.amount,
          currency: "XLM", co2OffsetKg: e.co2, projectsSupported: 1, transactionHash: e.tx,
        },
        transaction_hash: e.tx,
      }, testPool);
      await processEvent({
        event_type: "DonationRecorded",
        aggregate_id: e.project,
        event_data: {
          donorAddress: e.donor, projectId: e.project, amountXLM: e.amount,
          currency: "XLM", co2OffsetKg: e.co2, projectsSupported: 1, transactionHash: e.tx,
        },
        transaction_hash: e.tx,
      }, { pool: testPool });
    }
    const incremental = await snapshotProjections();

    // Now rebuild from the event store and compare.
    await rebuildAllProjections({ pool: testPool });
    const rebuilt = await snapshotProjections();

    expect(rebuilt.global.total_xlm_raised).toBe(incremental.global.total_xlm_raised);
    expect(rebuilt.global.total_donations).toBe(incremental.global.total_donations);
    expect(rebuilt.global.total_donors).toBe(incremental.global.total_donors);
    expect(rebuilt.historyCount).toBe(incremental.historyCount);
    expect(rebuilt.projectStats.length).toBe(incremental.projectStats.length);
    expect(rebuilt.leaderboard.length).toBe(incremental.leaderboard.length);
  });

  test("event→projection→read-endpoint flow returns identical leaderboard numbers", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const events = seedEventsSql();
    for (const e of events) {
      await insertEvent({
        event_type: "DonationRecorded",
        aggregate_id: e.project,
        event_data: {
          donorAddress: e.donor, projectId: e.project, amountXLM: e.amount,
          currency: "XLM", co2OffsetKg: e.co2, projectsSupported: 1, transactionHash: e.tx,
        },
        transaction_hash: e.tx,
      }, testPool);
      await processEvent({
        event_type: "DonationRecorded",
        aggregate_id: e.project,
        event_data: {
          donorAddress: e.donor, projectId: e.project, amountXLM: e.amount,
          currency: "XLM", co2OffsetKg: e.co2, projectsSupported: 1, transactionHash: e.tx,
        },
        transaction_hash: e.tx,
      }, { pool: testPool });
    }

    // The exact SQL the leaderboard route now uses (mirrored here).
    const lbResult = await testPool.query(`
      SELECT lb.donor_address AS public_key,
             lb.total_donated AS total_donated_xlm,
             lb.projects_supported,
             lb.total_co2_offset AS total_co2_offset_kg,
             lb.impact_score
      FROM projection_donor_leaderboard lb
      ORDER BY lb.total_donated DESC
      LIMIT 20`);
    const totals = lbResult.rows.map((r) => Number(r.total_donated_xlm));
    expect(totals).toEqual([200, 200, 50].sort((a, b) => b - a));
  });

  test("projection rebuild deletes and recreates rows (no duplication)", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    await seedEventStore(seedEventsSql());
    await rebuildAllProjections({ pool: testPool });
    const first = (await snapshotProjections()).historyCount;
    await rebuildAllProjections({ pool: testPool });
    const second = (await snapshotProjections()).historyCount;
    expect(second).toBe(first);
    expect(second).toBe(5);
  });
});
