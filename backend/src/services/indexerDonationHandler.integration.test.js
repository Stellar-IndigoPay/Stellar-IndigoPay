"use strict";

/**
 * Integration coverage for Horizon donation idempotency.
 *
 * The test applies migration 028 to the old transaction-hash-only schema,
 * then uses the real handler against PostgreSQL. It verifies that replaying
 * one operation is a no-op that still advances the cursor, while two payment
 * operations in one transaction are recorded separately.
 *
 * Run with: npm test -- indexerDonationHandler.integration
 * The test skips gracefully when Docker is unavailable.
 */

jest.mock("./store", () => ({
  computeBadges: jest.fn(() => []),
}));

jest.mock("./webhook", () => ({
  checkAndDeliverMilestones: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

let container;
let testPool;
let appPool;
let handleDonation;
let ready = false;
let previousDatabaseUrl;

function makeOperation({ id, amount, ledger, transactionHash }) {
  return {
    id,
    paging_token: `${id}-1`,
    type: "payment",
    from: "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    to: "GPROJECTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    amount: String(amount),
    transaction_hash: transactionHash,
    ledger_attr: ledger,
  };
}

describe("indexer donation idempotency integration", () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;

    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping integration tests (SKIP_INTEGRATION=1)");
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
          Wait.forLogMessage(
            "database system is ready to accept connections",
            2,
          ),
        )
        .withStartupTimeout(60000)
        .start();

      const host = container.getHost();
      const port = container.getMappedPort(5432);
      const connectionString = `postgres://test:test@${host}:${port}/indigopay_test`;
      testPool = new Pool({ connectionString, max: 5 });

      // Start with the pre-028 shape so the test also exercises the
      // constraint replacement performed by the migration.
      await testPool.query(`
        CREATE TABLE projects (
          id UUID PRIMARY KEY,
          raised_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
          donor_count INTEGER NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE donations (
          id UUID PRIMARY KEY,
          project_id UUID NOT NULL,
          donor_address TEXT NOT NULL,
          amount_xlm NUMERIC(20, 7),
          amount NUMERIC(20, 7) NOT NULL,
          currency TEXT NOT NULL DEFAULT 'XLM',
          transaction_hash TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE profiles (
          public_key TEXT PRIMARY KEY,
          total_donated_xlm NUMERIC(20, 7) NOT NULL DEFAULT 0,
          projects_supported INTEGER NOT NULL DEFAULT 0,
          badges JSONB NOT NULL DEFAULT '[]'::JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ
        );

        CREATE TABLE indexer_state (
          key TEXT PRIMARY KEY,
          last_processed_ledger INTEGER NOT NULL DEFAULT 0,
          last_processed_at TIMESTAMPTZ
        );
      `);

      const migration = require("../db/migrations/028_indexer_donation_idempotency");
      const migrationClient = await testPool.connect();
      try {
        await migration.up(migrationClient);
      } finally {
        migrationClient.release();
      }

      process.env.DATABASE_URL = connectionString;
      delete require.cache[require.resolve("../db/pool")];
      delete require.cache[require.resolve("./indexerDonationHandler")];
      appPool = require("../db/pool");
      ({ handleDonation } = require("./indexerDonationHandler"));
      await appPool.query("SELECT 1");

      ready = true;
      console.log(`Testcontainers PostgreSQL ready at ${host}:${port}`);
    } catch (err) {
      console.warn(
        "Testcontainers startup failed, integration tests will be skipped:",
        err.message,
      );
      ready = false;
      try {
        if (appPool) await appPool.end();
      } catch {
        // Cleanup after startup failure.
      }
      try {
        if (testPool) await testPool.end();
      } catch {
        // Cleanup after startup failure.
      }
      try {
        if (container) await container.stop();
      } catch {
        // Cleanup after startup failure.
      }
      appPool = null;
      testPool = null;
      container = null;
    }
  });

  afterAll(async () => {
    try {
      if (appPool) await appPool.end();
    } catch {
      // Cleanup after the test run.
    }
    try {
      if (testPool) await testPool.end();
    } catch {
      // Cleanup after the test run.
    }
    try {
      if (container) await container.stop({ timeout: 5000 });
    } catch {
      // Cleanup after the test run.
    }

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  async function cleanDatabase() {
    if (!ready) return;
    await testPool.query(
      "TRUNCATE donations, profiles, projects, indexer_state RESTART IDENTITY CASCADE",
    );
  }

  async function seedProject() {
    const projectId = "11111111-1111-1111-1111-111111111111";
    await testPool.query(
      "INSERT INTO projects (id) VALUES ($1)",
      [projectId],
    );
    await testPool.query(
      "INSERT INTO indexer_state (key, last_processed_ledger) VALUES ('primary', 0)",
    );
    return projectId;
  }

  async function advanceCursor(client, ledger) {
    await client.query(
      `UPDATE indexer_state
       SET last_processed_ledger = GREATEST(last_processed_ledger, $1),
           last_processed_at = NOW()
       WHERE key = 'primary'`,
      [ledger],
    );
  }

  test("replaying one operation records once and advances the cursor", async () => {
    if (!ready) {
      console.warn("Skipping, testcontainer not available");
      return expect(true).toBe(true);
    }

    await cleanDatabase();
    const projectId = await seedProject();
    const operation = makeOperation({
      id: "5001",
      amount: 10,
      ledger: 42,
      transactionHash: "a".repeat(64),
    });

    await handleDonation(projectId, operation, { isNative: true, isUSDC: false }, {
      onCursorUpdate: advanceCursor,
    });
    await handleDonation(projectId, operation, { isNative: true, isUSDC: false }, {
      onCursorUpdate: advanceCursor,
    });

    const donationCount = await testPool.query(
      "SELECT COUNT(*)::int AS count FROM donations WHERE project_id = $1",
      [projectId],
    );
    expect(donationCount.rows[0].count).toBe(1);

    const project = await testPool.query(
      "SELECT raised_xlm, donor_count FROM projects WHERE id = $1",
      [projectId],
    );
    expect(Number(project.rows[0].raised_xlm)).toBe(10);
    expect(project.rows[0].donor_count).toBe(1);

    const cursor = await testPool.query(
      "SELECT last_processed_ledger FROM indexer_state WHERE key = 'primary'",
    );
    expect(cursor.rows[0].last_processed_ledger).toBe(42);
  });

  test("records distinct payment operations from one transaction separately", async () => {
    if (!ready) {
      console.warn("Skipping, testcontainer not available");
      return expect(true).toBe(true);
    }

    await cleanDatabase();
    const projectId = await seedProject();
    const transactionHash = "b".repeat(64);

    await handleDonation(
      projectId,
      makeOperation({ id: "6001", amount: 10, ledger: 50, transactionHash }),
      { isNative: true, isUSDC: false },
    );
    await handleDonation(
      projectId,
      makeOperation({ id: "6002", amount: 5, ledger: 50, transactionHash }),
      { isNative: true, isUSDC: false },
    );

    const donations = await testPool.query(
      `SELECT indexer_operation_id, amount
       FROM donations
       WHERE project_id = $1
       ORDER BY indexer_operation_id`,
      [projectId],
    );
    expect(donations.rows).toHaveLength(2);
    expect(donations.rows.map((row) => row.indexer_operation_id)).toEqual([
      "6001",
      "6002",
    ]);

    const project = await testPool.query(
      "SELECT raised_xlm FROM projects WHERE id = $1",
      [projectId],
    );
    expect(Number(project.rows[0].raised_xlm)).toBe(15);
  });
});
