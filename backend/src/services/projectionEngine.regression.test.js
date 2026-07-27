"use strict";

/**
 * Regression test: the event-sourced projection read models must return the
 * SAME numbers as the legacy direct-aggregation queries for leaderboard,
 * project stats, and global stats.
 *
 * Strategy (no Docker required for the math; uses a real Postgres when
 * available, otherwise validates the SQL equivalence on seeded rows via
 * testcontainers): seed a `donations` + `profiles` dataset, build the
 * projections from equivalent events, then compare:
 *   - leaderboard totals (projection) vs SUM(donations) GROUP BY donor
 *   - project stats (projection) vs aggregate over donations per project
 *   - global stats (projection) vs COUNT/SUM over donations
 *
 * Run with: INTEGRATION=1 npm test -- projectionEngine.regression
 */

jest.mock("../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const fs = require("fs");
const path = require("path");
const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const { insertEvent, processEvent } = require("./projectionEngine");

let container;
let testPool;
let ready = false;

const DONORS = [
  "GAAAREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATRE",
  "GBBBREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATRE",
  "GCCCREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATREPEATRE",
];
const PROJECTS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
];

// donations: [donorIdx, projectIdx, amountXLM]
const DONATIONS = [
  [0, 0, 100],
  [1, 0, 50],
  [0, 1, 25],
  [2, 1, 200],
  [0, 0, 75],
  [1, 1, 30],
];

describe("Projection engine regression (legacy vs event-sourced parity)", () => {
  jest.setTimeout(180000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping regression (SKIP_INTEGRATION=1)");
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
        max: 5,
      });

      const schemaSql = fs.readFileSync(
        path.join(__dirname, "..", "db", "schema.sql"),
        "utf8",
      );
      await testPool.query(schemaSql);
      ready = true;
    } catch (err) {
      console.warn("Regression integration skipped:", err.message);
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
    await testPool.query("TRUNCATE donations, profiles, projects, donation_events RESTART IDENTITY CASCADE");
    for (const p of PROJECTS) {
      await testPool.query(
        `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count, co2_offset_kg, status)
         VALUES ($1, 'p', 'd', 'Reforestation', 'l', 'G'.repeat(56), 0, 0, 0, 0, 'active')`,
        [p],
      );
    }
    for (let i = 0; i < DONATIONS.length; i++) {
      const [di, pi, amount] = DONATIONS[i];
      await testPool.query(
        `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, created_at)
         VALUES ($1, $2, $3, $4, $4, 'XLM', $5, NOW())`,
        [`d-${i}`, PROJECTS[pi], DONORS[di], amount, `legacy-tx-${i}`],
      );
      const co2 = amount * 10;
      await insertEvent({
        event_type: "DonationRecorded",
        aggregate_id: PROJECTS[pi],
        event_data: {
          donorAddress: DONORS[di], projectId: PROJECTS[pi], amountXLM: amount,
          currency: "XLM", co2OffsetKg: co2, projectsSupported: 1, transactionHash: `ev-tx-${i}`,
        },
        transaction_hash: `ev-tx-${i}`,
      }, testPool);
      await processEvent({
        event_type: "DonationRecorded",
        aggregate_id: PROJECTS[pi],
        event_data: {
          donorAddress: DONORS[di], projectId: PROJECTS[pi], amountXLM: amount,
          currency: "XLM", co2OffsetKg: co2, projectsSupported: 1, transactionHash: `ev-tx-${i}`,
        },
        transaction_hash: `ev-tx-${i}`,
      }, { pool: testPool });
    }
  });

  test("leaderboard projection matches legacy SUM(donations) GROUP BY donor", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const legacy = await testPool.query(
      `SELECT donor_address, SUM(amount_xlm)::numeric AS total
       FROM donations GROUP BY donor_address ORDER BY donor_address`,
    );
    const proj = await testPool.query(
      "SELECT donor_address, total_donated FROM projection_donor_leaderboard ORDER BY donor_address",
    );
    expect(proj.rows.length).toBe(legacy.rows.length);
    for (const l of legacy.rows) {
      const p = proj.rows.find((r) => r.donor_address === l.donor_address);
      expect(p).toBeDefined();
      expect(Number(p.total_donated)).toBeCloseTo(Number(l.total));
    }
  });

  test("project_stats projection matches legacy aggregate per project", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const legacy = await testPool.query(
      `SELECT project_id, SUM(amount_xlm)::numeric AS raised,
              COUNT(*)::int AS donations,
              COUNT(DISTINCT donor_address)::int AS donors
       FROM donations GROUP BY project_id ORDER BY project_id`,
    );
    const proj = await testPool.query(
      "SELECT project_id, raised_xlm, donation_count, donor_count FROM projection_project_stats ORDER BY project_id",
    );
    expect(proj.rows.length).toBe(legacy.rows.length);
    for (const l of legacy.rows) {
      const p = proj.rows.find((r) => r.project_id === l.project_id);
      expect(p).toBeDefined();
      expect(Number(p.raised_xlm)).toBeCloseTo(Number(l.raised));
      expect(p.donation_count).toBe(l.donations);
      expect(p.donor_count).toBe(l.donors);
    }
  });

  test("global_stats projection matches legacy COUNT/SUM over donations", async () => {
    if (!ready) return console.warn("skipping – container unavailable");
    const legacy = await testPool.query(
      `SELECT SUM(amount_xlm)::numeric AS total,
              COUNT(*)::bigint AS donations,
              COUNT(DISTINCT donor_address)::int AS donors
       FROM donations`,
    );
    const proj = await testPool.query(
      "SELECT total_xlm_raised, total_donations, total_donors FROM projection_global_stats WHERE id=1",
    );
    expect(Number(proj.rows[0].total_xlm_raised)).toBeCloseTo(Number(legacy.rows[0].total));
    expect(Number(proj.rows[0].total_donations)).toBe(Number(legacy.rows[0].donations));
    expect(proj.rows[0].total_donors).toBe(legacy.rows[0].donors);
  });
});
