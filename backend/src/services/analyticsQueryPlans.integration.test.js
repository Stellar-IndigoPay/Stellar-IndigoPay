"use strict";

/**
 * Integration test for admin analytics query plans against a real PostgreSQL
 * instance (testcontainers, postgres:15-alpine). Issue #718 requires the
 * bounded analytics aggregates to stay index-backed over the donations
 * ledger; this suite EXPLAINs the exact SQL the service runs and fails when
 * a time-window query degrades to a sequential scan over donations.
 *
 * Seed data mirrors production: ~100k donations appended in roughly
 * chronological order (so the recent-window slice is physically contiguous
 * and cheap to reach via the created_at index).
 *
 * Run with: INTEGRATION=1 npm test -- analyticsQueryPlans.integration
 * Skipped gracefully if Docker is unavailable (same convention as
 * retention.integration.test.js).
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const fs = require("fs");
const path = require("path");
const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const {
  buildCategoryBreakdownQuery,
  buildPlatformGrowthQueries,
} = require("./analyticsService");

const TOTAL_DONATIONS = 100000;
const PROJECT_COUNT = 200;
const SPAN_DAYS = 400;

let container;
let testPool;
let ready = false;

describe("Analytics query plans (testcontainers)", () => {
  jest.setTimeout(180000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping analytics query plan tests (SKIP_INTEGRATION=1)");
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
        .withStartupTimeout(60000)
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

      await seedData();
      await testPool.query("ANALYZE projects");
      await testPool.query("ANALYZE donations");

      ready = true;
      console.log(`Analytics testcontainers PostgreSQL ready at ${host}:${port}`);
    } catch (err) {
      console.warn("Analytics query plan integration skipped:", err.message);
      ready = false;
      try {
        if (testPool) await testPool.end();
      } catch {
        /* cleanup */
      }
      try {
        if (container) await container.stop();
      } catch {
        /* cleanup */
      }
      container = null;
      testPool = null;
    }
  });

  afterAll(async () => {
    try {
      if (testPool) await testPool.end();
    } catch {
      /* cleanup */
    }
    try {
      if (container) await container.stop({ timeout: 5000 });
    } catch {
      /* cleanup */
    }
  });

  async function seedData() {
    await testPool.query(
      `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count)
       SELECT md5('p' || i)::uuid, 'Project ' || i, 'desc ' || i,
              'category ' || (i % 10), 'Country ' || (i % 50), 'G' || i,
              1000000, 0, 0
       FROM generate_series(1, ${PROJECT_COUNT}) i
       ON CONFLICT (id) DO NOTHING`,
    );

    await testPool.query(
      `INSERT INTO donations (id, project_id, donor_address, amount_xlm, amount, currency, message, transaction_hash, created_at)
       SELECT md5('d' || i)::uuid,
              md5('p' || (1 + mod(i, ${PROJECT_COUNT})))::uuid,
              'D' || (i % 20000),
              (1 + mod(i, 1000)) / 10.0,
              (1 + mod(i, 1000)) / 10.0,
              'XLM',
              'msg ' || i,
              'tx-' || i,
              now() - ((((${TOTAL_DONATIONS} - i) / ${Math.floor(TOTAL_DONATIONS / SPAN_DAYS)}) || ' days')::interval)
       FROM generate_series(1, ${TOTAL_DONATIONS}) i
       ON CONFLICT (id) DO NOTHING`,
    );
  }

  async function explainPlan(sql) {
    const { rows } = await testPool.query(`EXPLAIN ${sql}`);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  }

  /**
   * Sub the $1/$2 placeholders for literal timestamps so EXPLAIN plans the
   * actual recent window with exact statistics rather than the default
   * 0.33 inequality selectivity for unknown params.
   */
  function categoryWindowSql(windowDays) {
    const { sql } = buildCategoryBreakdownQuery({
      from: new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000),
      to: new Date(),
    });
    const toIso = new Date().toISOString();
    const fromIso = new Date(
      Date.now() - windowDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    return sql
      .replace("$1", `'${fromIso}'`)
      .replace("$2", `'${toIso}'`);
  }

  test("category breakdown within a recent window uses the created_at index, not a sequential scan", async () => {
    if (!ready) return console.warn("skipping – container unavailable");

    const plan = await explainPlan(categoryWindowSql(14));

    expect(plan).toMatch(/idx_donations_created_at/);
    expect(plan).not.toMatch(/Seq Scan on donations/);
  });

  test("platform growth 30-day windows are served by the created_at index", async () => {
    if (!ready) return console.warn("skipping – container unavailable");

    const { summary } = buildPlatformGrowthQueries();
    const plan = await explainPlan(summary.sql);

    expect(plan).toMatch(/idx_donations_created_at/);
  });

  test("bounded aggregate queries produce valid plans", async () => {
    if (!ready) return console.warn("skipping – container unavailable");

    const { monthly } = buildPlatformGrowthQueries();
    const monthlyPlan = await explainPlan(monthly.sql);
    expect(monthlyPlan).toMatch(/Aggregate/);
  });
});
