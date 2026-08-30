"use strict";

/**
 * Integration test for audit retention + chain verification (issue #685).
 *
 * Verifies that when retention prunes the oldest audit rows (including the
 * genesis row), `auditChain.verifyChain` still validates the surviving suffix
 * by resuming from the locally-recorded anchor in `audit_chain_anchor`.
 *
 * Run with: INTEGRATION=1 npm test -- auditRetention.integration
 * Skipped gracefully if Docker is unavailable.
 */

const { GenericContainer, Wait } = require("testcontainers");
const { Pool } = require("pg");

const {
  GENESIS_PREV_HASH,
  computeRowHash,
  verifyChain,
} = require("./auditChain");
const { dropOldPartitions } = require("./auditRetention");

let container;
let testPool;
let ready = false;

const ORIGINAL_RETENTION_ENABLED = process.env.AUDIT_LOG_RETENTION_ENABLED;

describe("Audit retention + hash-chain verification (testcontainers)", () => {
  jest.setTimeout(120000);

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping audit retention integration (SKIP_INTEGRATION=1)");
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
      testPool = new Pool({
        connectionString: `postgres://test:test@${host}:${port}/indigopay_test`,
        max: 5,
      });

      await testPool.query(`
        CREATE TABLE IF NOT EXISTS admin_audit_log (
          id TEXT PRIMARY KEY,
          actor TEXT,
          action TEXT,
          target_type TEXT,
          target_id TEXT,
          metadata TEXT,
          ip_address TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          prev_hash TEXT,
          row_hash TEXT
        )
      `);
      await testPool.query(`
        CREATE TABLE IF NOT EXISTS audit_chain_anchor (
          id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          anchor_hash TEXT NOT NULL,
          anchor_row_id TEXT,
          anchored_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reason TEXT NOT NULL DEFAULT 'retention'
        )
      `);

      // Retention deletes are destructive; enable them for this test only.
      process.env.AUDIT_LOG_RETENTION_ENABLED = "true";

      ready = true;
      console.log(`Audit retention testcontainers PostgreSQL ready at ${host}:${port}`);
    } catch (err) {
      console.warn("Audit retention integration skipped:", err.message);
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
    process.env.AUDIT_LOG_RETENTION_ENABLED = ORIGINAL_RETENTION_ENABLED;
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

  const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

  async function seedAuditChain(idsAgesMonths) {
    await testPool.query("TRUNCATE admin_audit_log");
    await testPool.query("DELETE FROM audit_chain_anchor");
    const now = Date.now();
    let prev = GENESIS_PREV_HASH;
    for (const { id, ageMonths } of idsAgesMonths) {
      const createdAt = new Date(now - ageMonths * MONTH_MS).toISOString();
      const rowHash = computeRowHash({
        id,
        actor: "admin",
        action: `action-${id}`,
        targetType: null,
        targetId: null,
        metadata: "{}",
        ipAddress: null,
        created_at: createdAt,
        prev_hash: prev,
      });
      await testPool.query(
        `INSERT INTO admin_audit_log
           (id, actor, action, target_type, target_id, metadata, ip_address, created_at, prev_hash, row_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [id, "admin", `action-${id}`, null, null, "{}", null, createdAt, prev, rowHash],
      );
      prev = rowHash;
    }
    return prev;
  }

  test("verifyChain survives pruning the genesis and older rows", async () => {
    if (!ready) return console.warn("skipping – container unavailable");

    // 4 rows older than the 12-month retention window, 1 fresh survivor.
    await seedAuditChain([
      { id: "r1", ageMonths: 40 },
      { id: "r2", ageMonths: 36 },
      { id: "r3", ageMonths: 30 },
      { id: "r4", ageMonths: 24 },
      { id: "r5", ageMonths: 0 },
    ]);

    // Sanity: the full chain verifies before pruning.
    expect((await verifyChain(testPool)).valid).toBe(true);

    const res = await dropOldPartitions(testPool, 12);
    expect(res.enabled).toBe(true);
    expect(res.deleted).toBe(4);

    // Only the fresh row survives, but verification must still pass.
    const after = await verifyChain(testPool);
    expect(after.valid).toBe(true);
    expect(after.anchored).toBe(true);
    expect(after.checked).toBe(1);

    // The anchor records the oldest surviving row's prev_hash.
    const { rows } = await testPool.query(
      "SELECT anchor_hash, anchor_row_id FROM audit_chain_anchor WHERE id = 1",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].anchor_row_id).toBe("r5");

    const { rows: survivors } = await testPool.query(
      "SELECT id, prev_hash FROM admin_audit_log ORDER BY created_at ASC, id ASC",
    );
    expect(survivors).toHaveLength(1);
    expect(rows[0].anchor_hash).toBe(survivors[0].prev_hash);
  });

  test("emptying the log clears the anchor so a fresh genesis can start", async () => {
    if (!ready) return console.warn("skipping – container unavailable");

    await seedAuditChain([
      { id: "r1", ageMonths: 40 },
      { id: "r2", ageMonths: 36 },
    ]);

    // A 0-month window deletes every row whose created_at is before now().
    const res = await dropOldPartitions(testPool, 0);
    expect(res.enabled).toBe(true);
    expect(res.deleted).toBe(2);

    const { rows } = await testPool.query("SELECT COUNT(*)::bigint AS c FROM admin_audit_log");
    expect(Number(rows[0].c)).toBe(0);

    const anchor = await testPool.query("SELECT * FROM audit_chain_anchor WHERE id = 1");
    expect(anchor.rows).toHaveLength(0);

    const after = await verifyChain(testPool);
    expect(after.valid).toBe(true);
    expect(after.anchored).toBe(false);
    expect(after.checked).toBe(0);
  });
});
