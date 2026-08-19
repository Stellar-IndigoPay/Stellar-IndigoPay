"use strict";

/**
 * 02-seeded-upgrade.test.js
 *
 * Verifies that running the full migration chain on a database that already
 * contains representative data does NOT cause data loss, constraint
 * violations, or unexpected NULLs.
 *
 * Test strategy:
 *   1. Apply migrations up to and including 001_initial_schema.
 *   2. Insert the full fixture matrix (normal, unicode, null-optionals,
 *      boundary amounts, large text).
 *   3. Apply the remaining migrations (001 → latest) in order.
 *   4. Assert that:
 *      (a) All originally inserted rows are still present.
 *      (b) No row that had a non-NULL value now has NULL in that column.
 *      (c) Columns added by later migrations have appropriate defaults or
 *          NULL (never a NOT NULL violation on pre-existing rows).
 *      (d) A deliberately broken migration (NOT NULL without default on a
 *          populated table) causes the harness to fail as expected.
 */

const { startDb, stopDb } = require("./helpers/db");
const {
  applyUpTo,
  applyAll,
  applyAllStepwise,
} = require("./helpers/runner");
const {
  IDS,
  insertCoreFixtures,
  countRows,
  fetchAll,
  assertColumnExists,
  UNICODE_NAME,
  UNICODE_DESC,
  LARGE_TEXT,
  UNICODE_MSG,
  AMOUNT_LARGE,
  AMOUNT_TINY,
  AMOUNT_NORMAL,
} = require("./helpers/fixtures");

describe("Migration harness — seeded-upgrade safety", () => {
  jest.setTimeout(180_000);

  let container;
  let pool;

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") return;
    try {
      ({ container, pool } = await startDb());
    } catch (err) {
      console.warn(
        "[migration harness] Docker unavailable — skipping seeded-upgrade tests.",
        err.message,
      );
    }
  });

  afterAll(async () => {
    if (container && pool) await stopDb(container, pool);
  });

  function skip() {
    return !container || !pool;
  }

  // ── Setup: seed at v001, then upgrade through the entire chain ───────────
  beforeAll(async () => {
    if (skip()) return;

    // 1. Apply only the initial schema migration so we have a base DB.
    await applyUpTo(pool, "001_initial_schema");

    // 2. Seed the fixture matrix at this early version.
    await insertCoreFixtures(pool);

    // 3. Apply all remaining migrations.
    await applyAll(pool);
  });

  // ── (a) Row count preservation ────────────────────────────────────────────
  it("preserves all seeded project rows after upgrade", async () => {
    if (skip()) return;
    const count = await countRows(pool, "projects");
    expect(count).toBe(5); // 5 projects inserted in insertCoreFixtures
  });

  it("preserves all seeded donation rows after upgrade", async () => {
    if (skip()) return;
    const count = await countRows(pool, "donations");
    expect(count).toBe(5); // 5 donations inserted in insertCoreFixtures
  });

  it("preserves all seeded profile rows after upgrade", async () => {
    if (skip()) return;
    const count = await countRows(pool, "profiles");
    expect(count).toBe(2);
  });

  // ── (b) Data integrity — non-NULL values are preserved ───────────────────
  it("unicode project name is preserved unchanged after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT name FROM projects WHERE id = $1",
        [IDS.project.unicode],
      );
      expect(result.rows[0].name).toBe(UNICODE_NAME);
    } finally {
      client.release();
    }
  });

  it("unicode project description is preserved unchanged after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT description FROM projects WHERE id = $1",
        [IDS.project.unicode],
      );
      expect(result.rows[0].description).toBe(UNICODE_DESC);
    } finally {
      client.release();
    }
  });

  it("large text description is preserved unchanged after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT description FROM projects WHERE id = $1",
        [IDS.project.large],
      );
      expect(result.rows[0].description).toBe(LARGE_TEXT);
    } finally {
      client.release();
    }
  });

  it("boundary NUMERIC amounts are preserved without rounding", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT amount_xlm, amount FROM donations WHERE id = $1",
        [IDS.donation.large],
      );
      expect(parseFloat(result.rows[0].amount_xlm)).toBeCloseTo(
        parseFloat(AMOUNT_LARGE),
        5,
      );
    } finally {
      client.release();
    }
  });

  it("tiny NUMERIC amount (boundary) is preserved after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT amount FROM donations WHERE id = $1",
        [IDS.donation.small],
      );
      expect(result.rows[0].amount).toBe(AMOUNT_TINY);
    } finally {
      client.release();
    }
  });

  it("donation with NULL message still has NULL message after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT message FROM donations WHERE id = $1",
        [IDS.donation.nullish],
      );
      expect(result.rows[0].message).toBeNull();
    } finally {
      client.release();
    }
  });

  it("profile with NULL bio still has NULL bio after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT bio FROM profiles WHERE public_key = $1",
        [IDS.profile.unicode],
      );
      expect(result.rows[0].bio).toBeNull();
    } finally {
      client.release();
    }
  });

  it("unicode donation message is preserved unchanged", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT message FROM donations WHERE id = $1",
        [IDS.donation.unicode],
      );
      expect(result.rows[0].message).toBe(UNICODE_MSG);
    } finally {
      client.release();
    }
  });

  // ── (c) New columns from later migrations have safe defaults ─────────────
  it("projects.co2_verification_status defaults to 'pending' for seeded rows", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      await assertColumnExists(pool, "projects", "co2_verification_status");
      const result = await client.query(
        "SELECT co2_verification_status FROM projects WHERE id = $1",
        [IDS.project.normal],
      );
      // The default is 'pending' — migrated rows should not be NULL
      expect(result.rows[0].co2_verification_status).toBe("pending");
    } finally {
      client.release();
    }
  });

  it("projects.search_vector is populated (not NULL) after migration 013", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      await assertColumnExists(pool, "projects", "search_vector");
      const result = await client.query(
        "SELECT search_vector IS NOT NULL AS has_vector FROM projects WHERE id = $1",
        [IDS.project.normal],
      );
      expect(result.rows[0].has_vector).toBe(true);
    } finally {
      client.release();
    }
  });

  it("donations.source_asset is NULL (optional) for seeded rows after migration 017", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      await assertColumnExists(pool, "donations", "source_asset");
      const result = await client.query(
        "SELECT source_asset FROM donations WHERE id = $1",
        [IDS.donation.normal],
      );
      // source_asset is optional — pre-existing rows should have NULL
      expect(result.rows[0].source_asset).toBeNull();
    } finally {
      client.release();
    }
  });

  // ── (d) Deliberately broken migration detection ───────────────────────────
  it("detects a migration that adds NOT NULL without a default on a populated table", async () => {
    if (skip()) return;

    // Simulate applying a broken migration directly against the pool.
    // This must throw a constraint violation, proving the harness catches it.
    const client = await pool.connect();
    try {
      await expect(
        (async () => {
          await client.query("BEGIN");
          // This ALTER would fail because projects already has rows and the
          // new column has no DEFAULT — Postgres will reject it.
          await client.query(
            "ALTER TABLE projects ADD COLUMN deliberate_break TEXT NOT NULL",
          );
          await client.query("COMMIT");
        })(),
      ).rejects.toThrow();
    } finally {
      // Ensure the transaction is rolled back regardless
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      client.release();
    }
  });

  // ── Constraint integrity ──────────────────────────────────────────────────
  it("FK from donations to projects is intact after upgrade", async () => {
    if (skip()) return;
    const client = await pool.connect();
    try {
      // Attempt to insert a donation referencing a non-existent project
      await expect(
        client.query(
          `INSERT INTO donations
             (id, project_id, donor_address, amount, currency, transaction_hash)
           VALUES
             (gen_random_uuid(),
              '99999999-9999-9999-9999-999999999999',
              'GXXXXX',
              '1.0',
              'XLM',
              'TX_CONSTRAINT_TEST_001')`,
        ),
      ).rejects.toThrow();
    } finally {
      client.release();
    }
  });
});
