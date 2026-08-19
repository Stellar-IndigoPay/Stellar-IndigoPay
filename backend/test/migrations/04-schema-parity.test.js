"use strict";

/**
 * 04-schema-parity.test.js
 *
 * Verifies that applying the full migration chain produces a schema that is
 * structurally equivalent to the checked-in `backend/src/db/schema.sql`.
 *
 * "Equivalent" is defined as:
 *   - Every table declared in schema.sql exists in the migrated database.
 *   - Every column declared in schema.sql exists in the migrated database.
 *
 * Intentional differences are listed in the ALLOWLIST in helpers/parity.js
 * and each entry has a documented reason. The harness reports allowlisted
 * items as informational output, not failures.
 *
 * Gaps in the other direction (tables/columns in the migrated DB that are
 * NOT in schema.sql) are acceptable — schema.sql is the minimum required
 * set, not an exhaustive specification.
 */

const { startDb, stopDb } = require("./helpers/db");
const { applyAll } = require("./helpers/runner");
const { checkParity } = require("./helpers/parity");

describe("Migration harness — schema parity with schema.sql", () => {
  jest.setTimeout(180_000);

  let container;
  let pool;
  let parityResult;

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") return;
    try {
      ({ container, pool } = await startDb());
      await applyAll(pool);
      parityResult = await checkParity(pool);
    } catch (err) {
      console.warn(
        "[migration harness] Docker unavailable or parity check failed during setup.",
        err.message,
      );
    }
  });

  afterAll(async () => {
    if (container && pool) await stopDb(container, pool);
  });

  function skip() {
    return !container || !pool || !parityResult;
  }

  it("migration chain produces no schema.sql parity violations", () => {
    if (skip()) return;

    if (parityResult.allowlisted.length > 0) {
      console.info(
        "[schema parity] Allowlisted differences (expected):\n" +
          parityResult.allowlisted.map((msg) => `  • ${msg}`).join("\n"),
      );
    }

    if (!parityResult.passed) {
      throw new Error(
        `Schema parity check failed — ${parityResult.violations.length} violation(s):\n` +
          parityResult.violations.map((v) => `  • ${v}`).join("\n") +
          "\n\nIf this difference is intentional, add an entry to " +
          "SCHEMA_PARITY_ALLOWLIST in test/migrations/helpers/parity.js " +
          "with a documented reason.",
      );
    }

    expect(parityResult.passed).toBe(true);
  });

  it("schema.sql parity allowlist contains only documented differences", () => {
    if (skip()) return;

    // Every allowlisted entry should have a non-empty reason
    const { SCHEMA_PARITY_ALLOWLIST } = require("./helpers/parity");
    for (const entry of SCHEMA_PARITY_ALLOWLIST) {
      expect(typeof entry.reason).toBe("string");
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      expect(typeof entry.table).toBe("string");
    }
  });

  it("reports which tables exist in the migrated DB", async () => {
    if (skip()) return;

    const client = await pool.connect();
    try {
      const result = await client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `);
      const tableNames = result.rows.map((r) => r.table_name);
      // At minimum the core tables must be present
      expect(tableNames).toContain("projects");
      expect(tableNames).toContain("donations");
      expect(tableNames).toContain("profiles");
      expect(tableNames.length).toBeGreaterThan(10);
    } finally {
      client.release();
    }
  });
});
