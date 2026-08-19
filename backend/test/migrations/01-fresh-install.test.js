"use strict";

/**
 * 01-fresh-install.test.js
 *
 * Verifies that the full migration chain applies cleanly on a fresh database:
 *
 *   (a) Each migration applies without error (step-wise, with per-migration
 *       failure reporting).
 *   (b) Each migration is recorded in schema_migrations in order.
 *   (c) All expected core tables exist after the full chain.
 *   (d) No migration leaves the DB in an indeterminate state on failure
 *       (the harness detects and reports partial-apply failures).
 *
 * Skips gracefully when Docker is unavailable (SKIP_INTEGRATION=1 or
 * no Docker socket accessible).
 */

const { startDb, stopDb } = require("./helpers/db");
const { applyAllStepwise, listAllVersions } = require("./helpers/runner");
const { assertTableExists } = require("./helpers/fixtures");

const CORE_TABLES = [
  "projects",
  "donations",
  "profiles",
  "project_updates",
  "project_subscriptions",
  "jobs",
  "verification_requests",
  "attestations",
  "device_tokens",
  "refresh_tokens",
  "token_blacklist",
  "donation_events",
  "recurring_donations",
  "schema_migrations",
];

describe("Migration harness — fresh install", () => {
  jest.setTimeout(180_000); // container boot + all migrations

  let container;
  let pool;

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      return;
    }
    try {
      ({ container, pool } = await startDb());
    } catch (err) {
      console.warn(
        "[migration harness] Docker unavailable — skipping fresh-install tests.",
        err.message,
      );
    }
  });

  afterAll(async () => {
    if (container && pool) {
      await stopDb(container, pool);
    }
  });

  function skip() {
    return !container || !pool;
  }

  // ── (a) Each migration applies cleanly ──────────────────────────────────
  it("applies every migration without error", async () => {
    if (skip()) return;

    const results = await applyAllStepwise(pool);
    const failures = results.filter((r) => !r.ok);

    if (failures.length > 0) {
      const report = failures
        .map((r) => `  • ${r.version}: ${r.error?.message ?? "unknown error"}`)
        .join("\n");
      throw new Error(
        `${failures.length} migration(s) failed to apply:\n${report}`,
      );
    }

    const applied = results.filter((r) => !r.skipped);
    expect(applied.length).toBeGreaterThan(0);
  });

  // ── (b) Versions are recorded in schema_migrations ─────────────────────
  it("records all versions in schema_migrations in sort order", async () => {
    if (skip()) return;

    const client = await pool.connect();
    let rows;
    try {
      const result = await client.query(
        "SELECT version FROM schema_migrations ORDER BY version ASC",
      );
      rows = result.rows.map((r) => r.version);
    } finally {
      client.release();
    }

    const allVersions = listAllVersions();
    // Every discovered version should be recorded (no skips due to errors)
    for (const v of allVersions) {
      expect(rows).toContain(v);
    }
    // Versions must be in ascending sort order
    const sorted = [...rows].sort();
    expect(rows).toEqual(sorted);
  });

  // ── (c) All core tables exist ────────────────────────────────────────────
  it.each(CORE_TABLES)('table "%s" exists after full chain', async (table) => {
    if (skip()) return;
    await assertTableExists(pool, table);
  });

  // ── (d) Idempotency — applying twice is safe ─────────────────────────────
  it("running applyAllStepwise a second time is a no-op (idempotent)", async () => {
    if (skip()) return;

    const results = await applyAllStepwise(pool);
    const notSkipped = results.filter((r) => !r.skipped);
    // All migrations were already applied; nothing new should run
    expect(notSkipped).toHaveLength(0);
  });

  // ── Per-migration version ordering ───────────────────────────────────────
  it("all migration filenames sort in ascending lexicographic order", () => {
    const versions = listAllVersions();
    const sorted = [...versions].sort();
    expect(versions).toEqual(sorted);
  });
});
