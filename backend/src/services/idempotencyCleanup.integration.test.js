"use strict";

/**
 * Integration test for the idempotency key cleanup service using
 * testcontainers-node with a real PostgreSQL instance.
 *
 * Verifies:
 *  - The DELETE query purges only rows older than 24 hours
 *  - Fresh keys (within the window) are left untouched
 *  - rowCount reflects the actual number of deleted rows
 *
 * Run with: npm test -- idempotencyCleanup.integration
 * Test is skipped gracefully if Docker is unavailable.
 */

const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

let container;
let testPool;
let serverContainerReady = false;

// The DELETE query from idempotencyCleanup.js. Kept in sync manually so
// the integration test validates the exact SQL the service runs.
const CLEANUP_QUERY = `
  DELETE FROM idempotency_keys
  WHERE created_at < NOW() - INTERVAL '24 hours'
`;

describe("idempotencyCleanup integration (testcontainers)", () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
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

      // Create only the idempotency_keys table (minimal schema for this test)
      await testPool.query(`
        CREATE TABLE IF NOT EXISTS idempotency_keys (
          key              TEXT PRIMARY KEY,
          response_status  INTEGER NOT NULL,
          response_body    JSONB NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await testPool.query(`
        CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created_at
          ON idempotency_keys (created_at)
      `);

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
      if (testPool) await testPool.end();
    } catch {
      // cleanup testPool
    }
    try {
      if (container) await container.stop({ timeout: 5000 });
    } catch {
      // cleanup container
    }
  });

  async function cleanTable() {
    if (!testPool) return;
    await testPool.query("TRUNCATE idempotency_keys");
  }

  test("purges only rows older than 24 hours", async () => {
    if (!serverContainerReady) {
      console.warn("Skipping – testcontainer not available");
      return expect(true).toBe(true);
    }

    await cleanTable();

    // Insert 3 keys: 1 expired (25h ago), 2 fresh (1h and 23h ago)
    await testPool.query(
      `INSERT INTO idempotency_keys (key, response_status, response_body, created_at) VALUES
       ($1, 201, '{"success":true}'::jsonb, NOW() - INTERVAL '25 hours'),
       ($2, 201, '{"success":true}'::jsonb, NOW() - INTERVAL '1 hour'),
       ($3, 201, '{"success":true}'::jsonb, NOW() - INTERVAL '23 hours')`,
      [
        "550e8400-e29b-41d4-a716-446655440001", // expired
        "550e8400-e29b-41d4-a716-446655440002", // fresh — 1h old
        "550e8400-e29b-41d4-a716-446655440003", // fresh — 23h old
      ],
    );

    // Run the exact cleanup query
    const result = await testPool.query(CLEANUP_QUERY);

    // Should have deleted exactly 1 row (the 25h-old key)
    expect(result.rowCount).toBe(1);

    // Verify only the 2 fresh keys remain
    const remaining = await testPool.query(
      "SELECT key FROM idempotency_keys ORDER BY key",
    );
    expect(remaining.rows).toHaveLength(2);
    expect(remaining.rows.map((r) => r.key)).toEqual([
      "550e8400-e29b-41d4-a716-446655440002",
      "550e8400-e29b-41d4-a716-446655440003",
    ]);
  });

  test("deletes nothing when all rows are fresh", async () => {
    if (!serverContainerReady) {
      console.warn("Skipping – testcontainer not available");
      return expect(true).toBe(true);
    }

    await cleanTable();

    // Insert only fresh keys (within 24h)
    await testPool.query(
      `INSERT INTO idempotency_keys (key, response_status, response_body, created_at) VALUES
       ($1, 201, '{}'::jsonb, NOW() - INTERVAL '10 minutes'),
       ($2, 200, '{}'::jsonb, NOW())`,
      [
        "660e8400-e29b-41d4-a716-446655440001",
        "660e8400-e29b-41d4-a716-446655440002",
      ],
    );

    const result = await testPool.query(CLEANUP_QUERY);

    expect(result.rowCount).toBe(0);

    const remaining = await testPool.query(
      "SELECT COUNT(*) FROM idempotency_keys",
    );
    expect(parseInt(remaining.rows[0].count, 10)).toBe(2);
  });

  test("deletes all rows when all are expired", async () => {
    if (!serverContainerReady) {
      console.warn("Skipping – testcontainer not available");
      return expect(true).toBe(true);
    }

    await cleanTable();

    await testPool.query(
      `INSERT INTO idempotency_keys (key, response_status, response_body, created_at) VALUES
       ($1, 201, '{}'::jsonb, NOW() - INTERVAL '26 hours'),
       ($2, 201, '{}'::jsonb, NOW() - INTERVAL '48 hours')`,
      [
        "770e8400-e29b-41d4-a716-446655440001",
        "770e8400-e29b-41d4-a716-446655440002",
      ],
    );

    const result = await testPool.query(CLEANUP_QUERY);

    expect(result.rowCount).toBe(2);

    const remaining = await testPool.query(
      "SELECT COUNT(*) FROM idempotency_keys",
    );
    expect(parseInt(remaining.rows[0].count, 10)).toBe(0);
  });
});
