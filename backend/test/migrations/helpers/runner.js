"use strict";

/**
 * helpers/runner.js
 *
 * Thin wrapper around the production migrate.js logic, adapted for the
 * harness so each test can operate against its own isolated pool instead of
 * the global application pool.
 *
 * Key differences from the production runner:
 *  - Accepts a pg.PoolClient directly — no module-level pool singleton.
 *  - Does NOT run seedDatabase() after migrations (no seeding in harness).
 *  - Exposes applyOne() / rollbackOne() for per-migration granularity.
 *  - Exposes applyUpTo(version) to apply migrations up to and including
 *    a specific version, which lets seeded-upgrade tests stop the chain at
 *    an earlier version and insert fixtures before continuing.
 */

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "../../../src/db/migrations");

// ── Schema migrations table ────────────────────────────────────────────────

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT        PRIMARY KEY,
      name       TEXT        NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

// ── File discovery ─────────────────────────────────────────────────────────

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => ({
      version: f.replace(".js", ""),
      file: path.join(MIGRATIONS_DIR, f),
    }));
}

async function getAppliedVersions(client) {
  const result = await client.query(
    "SELECT version FROM schema_migrations ORDER BY version ASC",
  );
  return result.rows.map((r) => r.version);
}

// ── Core apply / rollback ──────────────────────────────────────────────────

/**
 * Apply all pending migrations in order against `pool`.
 * Returns an array of version strings that were applied.
 */
async function applyAll(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = loadMigrationFiles();
    const ran = [];

    for (const { version, file } of files) {
      if (applied.includes(version)) continue;
      const migration = require(file);
      await migration.up(client);
      await client.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [version, migration.name ?? version],
      );
      ran.push(version);
    }

    await client.query("COMMIT");
    return ran;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply migrations one at a time and return per-migration results.
 * Each result: { version, ok, error }
 */
async function applyAllStepwise(pool) {
  const client = await pool.connect();
  const results = [];
  try {
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = loadMigrationFiles();

    for (const { version, file } of files) {
      if (applied.includes(version)) {
        results.push({ version, ok: true, skipped: true });
        continue;
      }

      try {
        await client.query("BEGIN");
        const migration = require(file);
        await migration.up(client);
        await client.query(
          "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
          [version, migration.name ?? version],
        );
        await client.query("COMMIT");
        results.push({ version, ok: true, skipped: false });
      } catch (err) {
        await client.query("ROLLBACK");
        results.push({ version, ok: false, skipped: false, error: err });
        // Stop on first failure — subsequent migrations likely depend on this one
        break;
      }
    }
  } finally {
    client.release();
  }

  return results;
}

/**
 * Apply migrations up to and including `targetVersion` (by sort order).
 * Useful to set up a partially-migrated DB before inserting fixtures.
 */
async function applyUpTo(pool, targetVersion) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);
    const applied = await getAppliedVersions(client);
    const files = loadMigrationFiles();
    const ran = [];

    for (const { version, file } of files) {
      if (applied.includes(version)) continue;
      const migration = require(file);
      await migration.up(client);
      await client.query(
        "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
        [version, migration.name ?? version],
      );
      ran.push(version);
      if (version === targetVersion) break;
    }

    await client.query("COMMIT");
    return ran;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Apply exactly one migration by version string against `pool`.
 */
async function applyOne(pool, version) {
  const file = path.join(MIGRATIONS_DIR, `${version}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`Migration file not found: ${file}`);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);
    const migration = require(file);
    await migration.up(client);
    await client.query(
      "INSERT INTO schema_migrations (version, name) VALUES ($1, $2)",
      [version, migration.name ?? version],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Roll back exactly one migration by version string against `pool`.
 * Throws if the migration does not export a `down()` function.
 */
async function rollbackOne(pool, version) {
  const file = path.join(MIGRATIONS_DIR, `${version}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`Migration file not found: ${file}`);
  }
  const migration = require(file);
  if (typeof migration.down !== "function") {
    throw new Error(
      `Migration ${version} does not export a down() function. ` +
        `Declare it irreversible in IRREVERSIBLE_MIGRATIONS if intentional.`,
    );
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await ensureMigrationsTable(client);
    await migration.down(client);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [
      version,
    ]);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Roll back all applied migrations in reverse order against `pool`.
 */
async function rollbackAll(pool) {
  const client = await pool.connect();
  let versionsToRollback = [];
  try {
    await ensureMigrationsTable(client);
    const result = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version DESC",
    );
    versionsToRollback = result.rows.map((r) => r.version);
  } finally {
    client.release();
  }

  for (const version of versionsToRollback) {
    await rollbackOne(pool, version);
  }
}

/**
 * List all migration versions (applied and pending) in sort order.
 */
function listAllVersions() {
  return loadMigrationFiles().map((f) => f.version);
}

/**
 * Return true if a migration exports a `down()` function.
 */
function isReversible(version) {
  const file = path.join(MIGRATIONS_DIR, `${version}.js`);
  if (!fs.existsSync(file)) return false;
  const migration = require(file);
  return typeof migration.down === "function";
}

module.exports = {
  applyAll,
  applyAllStepwise,
  applyUpTo,
  applyOne,
  rollbackOne,
  rollbackAll,
  listAllVersions,
  isReversible,
  MIGRATIONS_DIR,
};
