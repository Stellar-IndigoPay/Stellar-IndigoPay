"use strict";

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

jest.mock("./stellar", () => {
  const missingDonationOperation = {
    id: "missing-op-1",
    paging_token: "missing-op-1",
    type: "payment",
    from: "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    to: "GPROJECTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    amount: "10.0000000",
    transaction_hash: "reconcile-missing-donation",
    ledger_attr: 11,
    asset_type: "native",
    asset_code: null,
    asset_issuer: null,
  };

  return {
    server: {
      ledgers: jest.fn(() => ({
        limit: jest.fn(() => ({
          order: jest.fn(() => ({
            call: jest.fn().mockResolvedValue({ records: [{ sequence: 12 }] }),
          })),
        })),
      })),
      operations: jest.fn(() => ({
        cursor: jest.fn(() => ({
          limit: jest.fn(() => ({
            order: jest.fn(() => ({
              call: jest
                .fn()
                .mockResolvedValue({ records: [missingDonationOperation] }),
            })),
          })),
        })),
      })),
    },
  };
});

const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

let container;
let testPool;
let appPool;
let ready = false;
let previousDatabaseUrl;
let previousMaxLedgerLag;

async function cleanDatabase() {
  if (!ready || !testPool) return;
  await testPool.query(
    "TRUNCATE donations, profiles, projects, indexer_state RESTART IDENTITY CASCADE",
  );
}

async function seedProjectAndMissingDonation() {
  const projectId = "11111111-1111-1111-1111-111111111111";
  const projectWallet = "GPROJECTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
  const txHash = "reconcile-missing-donation";

  await testPool.query(
    "INSERT INTO projects (id, wallet_address, status) VALUES ($1, $2, 'active')",
    [projectId, projectWallet],
  );

  await testPool.query(
    "INSERT INTO indexer_state (key, last_processed_ledger) VALUES ('primary', 10)",
  );

  await testPool.query(
    `INSERT INTO donations (
      id, project_id, donor_address, amount_xlm, amount, currency, transaction_hash, created_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
    [
      "22222222-2222-2222-2222-222222222222",
      projectId,
      "GDONORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      10,
      10,
      "XLM",
      txHash,
    ],
  );

  await testPool.query("DELETE FROM donations WHERE transaction_hash = $1", [
    txHash,
  ]);

  return { projectId, projectWallet, txHash };
}

describe("indexer reconciler integration", () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
    previousDatabaseUrl = process.env.DATABASE_URL;
    previousMaxLedgerLag = process.env.INDEXER_MAX_LEDGER_LAG;
    process.env.INDEXER_MAX_LEDGER_LAG = "1";

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

      await testPool.query(`
        CREATE TABLE projects (
          id UUID PRIMARY KEY,
          wallet_address TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
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
          indexer_operation_id TEXT,
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
          backfill_in_progress BOOLEAN NOT NULL DEFAULT false,
          reconciled_at TIMESTAMPTZ,
          last_processed_at TIMESTAMPTZ
        );
      `);

      process.env.DATABASE_URL = connectionString;
      delete require.cache[require.resolve("../db/pool")];
      delete require.cache[require.resolve("./indexerBackfill")];
      delete require.cache[require.resolve("./indexerReconciler")];
      delete require.cache[require.resolve("./indexerService")];
      delete require.cache[require.resolve("./indexerDonationHandler")];

      appPool = require("../db/pool");
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
        // Ignore cleanup errors
      }

      try {
        if (testPool) await testPool.end();
      } catch {
        // Ignore cleanup errors
      }

      try {
        if (container) await container.stop();
      } catch {
        // Ignore cleanup errors
      }
      appPool = null;
      testPool = null;
      container = null;
    }
  });

  afterAll(async () => {
    if (appPool) await appPool.end();
    if (testPool) await testPool.end();
    if (container) await container.stop({ timeout: 5000 });

    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }

    if (previousMaxLedgerLag === undefined) {
      delete process.env.INDEXER_MAX_LEDGER_LAG;
    } else {
      process.env.INDEXER_MAX_LEDGER_LAG = previousMaxLedgerLag;
    }
  });

  it("repairs a missing donation when reconciler-triggered backfill detects ledger lag", async () => {
    if (!ready) {
      console.warn("Skipping, testcontainer not available");
      return expect(true).toBe(true);
    }

    await cleanDatabase();
    const { txHash } = await seedProjectAndMissingDonation();

    const { runReconciliation } = require("./indexerReconciler");
    const report = await runReconciliation();

    expect(report.backfillTriggered).toBe(true);
    expect(report.errors).toEqual([]);

    const restored = await appPool.query(
      "SELECT COUNT(*)::int AS count FROM donations WHERE transaction_hash = $1",
      [txHash],
    );
    expect(restored.rows[0].count).toBe(1);

    const cursor = await appPool.query(
      "SELECT last_processed_ledger FROM indexer_state WHERE key = 'primary'",
    );
    expect(Number(cursor.rows[0].last_processed_ledger)).toBeGreaterThanOrEqual(
      11,
    );
  });
});
