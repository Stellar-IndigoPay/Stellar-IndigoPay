"use strict";

/**
 * Integration test for migration advisory locking (issue #640).
 *
 * k8s runs multiple backend replicas (HPA min 2), each calling
 * runMigrations() at boot. Without a Postgres advisory lock the replicas
 * could apply the same migrations concurrently, risking partial application
 * or duplicate-schema errors. These tests verify that:
 *
 *  1. Two concurrent runMigrations() calls apply every migration exactly once.
 *  2. A runMigrations() call blocks on the advisory lock while another
 *     session holds it (it waits instead of racing).
 *  3. The advisory lock is released after runMigrations() completes.
 *
 * Run with: npm test -- migrate.integration
 * Test is skipped gracefully if Docker is unavailable.
 */

const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const fs = require("fs");
const path = require("path");

let container;
let testPool;
let migrate;
let serverContainerReady = false;

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

function countMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return 0;
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js")).length;
}

describe("migrate advisory lock (testcontainers)", () => {
  jest.setTimeout(180000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping integration tests (SKIP_INTEGRATION=1)");
      return;
    }

    try {
      container = await new GenericContainer("postgres:16-alpine")
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

      // Point the app pool at the container and reload migrate.js so pool.js
      // picks up DATABASE_URL at require time. Raise the statement timeout so
      // a replica blocked on the advisory lock never trips the 3s default
      // while the lock holder finishes applying migrations.
      process.env.DATABASE_URL = connectionString;
      process.env.DB_STATEMENT_TIMEOUT_MS = "60000";
      jest.resetModules();
      migrate = require("./migrate");

      serverContainerReady = true;
      console.log(
        `Testcontainers PostgreSQL ready at ${host}:${port}`,
      );
    } catch (err) {
      console.warn(
        "Testcontainers startup failed – integration tests will be skipped:",
        err.message,
      );
      serverContainerReady = false;
      try {
        if (testPool) await testPool.end();
      } catch {
        // cleanup after startup failure
      }
      try {
        if (container) await container.stop();
      } catch {
        // cleanup after startup failure
      }
      container = null;
      testPool = null;
    }
  });

  afterAll(async () => {
    try {
      // Close the app pool created when migrate.js was loaded.
      const pool = require("./pool");
      await pool.end();
    } catch {
      // pool may not have been created
    }
    try {
      if (testPool) await testPool.end();
    } catch {
      // cleanup testPool
    }
    try {
      if (container) await container.stop({ timeout: 5000 });
    } catch {
      // cleanup container
    }
    delete process.env.DATABASE_URL;
    delete process.env.DB_STATEMENT_TIMEOUT_MS;
  });

  async function resetSchema() {
    await testPool.query("DROP SCHEMA public CASCADE");
    await testPool.query("CREATE SCHEMA public");
  }

  test("two concurrent runMigrations calls apply each migration exactly once", async () => {
    if (!serverContainerReady) {
      console.warn("Skipping – testcontainer not available");
      return expect(true).toBe(true);
    }

    // Fresh database so both calls race to apply the full migration set —
    // exactly the multi-replica boot scenario from issue #640.
    await resetSchema();

    const [first, second] = await Promise.all([
      migrate.runMigrations(),
      migrate.runMigrations(),
    ]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();

    const { rows } = await testPool.query(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    const versions = rows.map((r) => r.version);

    expect(versions.length).toBeGreaterThan(0);
    expect(versions.length).toBe(countMigrationFiles());
    // Every migration was applied exactly once — no duplicate application.
    expect(new Set(versions).size).toBe(versions.length);
  });

  test("a concurrent runMigrations waits for the advisory lock instead of racing", async () => {
    if (!serverContainerReady) {
      console.warn("Skipping – testcontainer not available");
      return expect(true).toBe(true);
    }

    const lockClient = await testPool.connect();
    try {
      // Hold the migration lock from an unrelated session.
      await lockClient.query("SELECT pg_advisory_lock($1)", [
        migrate.migrationLockKey(),
      ]);

      let completed = false;
      const run = migrate.runMigrations().then(() => {
        completed = true;
      });

      // While the lock is held, the run must be blocked, not applying
      // migrations concurrently.
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(completed).toBe(false);

      // Release the lock: the blocked run proceeds and finishes.
      await lockClient.query("SELECT pg_advisory_unlock($1)", [
        migrate.migrationLockKey(),
      ]);
      await run;
      expect(completed).toBe(true);
    } finally {
      lockClient.release();
    }
  });

  test("releases the advisory lock after runMigrations completes", async () => {
    if (!serverContainerReady) {
      console.warn("Skipping – testcontainer not available");
      return expect(true).toBe(true);
    }

    await migrate.runMigrations();

    const client = await testPool.connect();
    try {
      const result = await client.query("SELECT pg_try_advisory_lock($1)", [
        migrate.migrationLockKey(),
      ]);
      // Lock is free — a fresh session can take it immediately.
      expect(result.rows[0].pg_try_advisory_lock).toBe(true);
      await client.query("SELECT pg_advisory_unlock($1)", [
        migrate.migrationLockKey(),
      ]);
    } finally {
      client.release();
    }
  });
});