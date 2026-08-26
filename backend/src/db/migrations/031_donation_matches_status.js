/**
 * 031_donation_matches_status
 *
 * The donation-matching feature shipped with a `status` lifecycle
 * (active → expired | exhausted | cancelled) in schema.sql, but the
 * migration path never added the column. `recordDonation` (routes/
 * donations.js) filters active offers with `WHERE status = 'active'` and
 * matchExpiry.js flips pools between statuses, so on a migration-built
 * database every XLM donation failed with `column "status" does not exist`.
 *
 * This migration closes the gap so the migration-built schema matches
 * schema.sql exactly.
 *
 * Ownership-aware rollback:
 * -------------------------
 * The column / constraint / index may ALREADY exist on databases that were
 * built from schema.sql (or where the objects were added by another path).
 * `up()` therefore only creates the objects that are missing, and records
 * which ones it created in `migration_created_objects`. `down()` then only
 * drops the objects this migration actually created — it never removes
 * pre-existing schema objects or their data.
 */

const MIGRATION_KEY = "031_donation_matches_status";

/**
 * Small metadata table tracking which objects a migration created, so a
 * rollback can be ownership-aware instead of blindly dropping anything with
 * a matching name. Created lazily (IF NOT EXISTS) by up/down.
 */
async function ensureStateTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS migration_created_objects (
      migration TEXT NOT NULL,
      object     TEXT NOT NULL,
      PRIMARY KEY (migration, object)
    )
  `);
}

/** Record which objects `up()` created so `down()` can drop them precisely. */
async function recordCreated(client, objects) {
  if (objects.length === 0) return;
  await ensureStateTable(client);
  for (const obj of objects) {
    await client.query(
      `INSERT INTO migration_created_objects (migration, object)
       VALUES ($1, $2)
       ON CONFLICT (migration, object) DO NOTHING`,
      [MIGRATION_KEY, obj],
    );
  }
}

/** Return the set of objects this migration recorded as created by it. */
async function getCreated(client) {
  await ensureStateTable(client);
  const result = await client.query(
    "SELECT object FROM migration_created_objects WHERE migration = $1",
    [MIGRATION_KEY],
  );
  return new Set(result.rows.map((row) => row.object));
}

/** Forget this migration's creation records (called at the end of `down()`). */
async function clearCreated(client) {
  await client.query(
    "DELETE FROM migration_created_objects WHERE migration = $1",
    [MIGRATION_KEY],
  );
}

/** True when `donation_matches` already has a column named `column`. */
async function columnExists(client, column) {
  const result = await client.query(
    `SELECT 1 FROM information_schema.columns
     WHERE table_name = 'donation_matches' AND column_name = $1`,
    [column],
  );
  return result.rows.length > 0;
}

/**
 * True when `donation_matches` already has a constraint named `name`.
 *
 * Restricted to the donation_matches relation (conrelid): conname alone is
 * only unique per schema, so a same-named constraint on another relation
 * could otherwise false-positive and skip the CREATE.
 */
async function constraintExists(client, name) {
  const result = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conrelid = 'donation_matches'::regclass AND conname = $1`,
    [name],
  );
  return result.rows.length > 0;
}

/** True when `donation_matches` already has an index named `name`. */
async function indexExists(client, name) {
  const result = await client.query(
    `SELECT 1 FROM pg_indexes
     WHERE tablename = 'donation_matches' AND indexname = $1`,
    [name],
  );
  return result.rows.length > 0;
}

module.exports = {
  name: "031_donation_matches_status",

  async up(client) {
    const created = [];

    if (!(await columnExists(client, "status"))) {
      await client.query(`
        ALTER TABLE donation_matches ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
      `);
      created.push("column:status");
    }

    if (!(await constraintExists(client, "donation_matches_status_check"))) {
      await client.query(`
        ALTER TABLE donation_matches ADD CONSTRAINT donation_matches_status_check
          CHECK (status IN ('active', 'expired', 'exhausted', 'cancelled'));
      `);
      created.push("constraint:donation_matches_status_check");
    }

    if (!(await indexExists(client, "idx_donation_matches_status"))) {
      await client.query(`
        CREATE INDEX idx_donation_matches_status
          ON donation_matches (status, project_id);
      `);
      created.push("index:idx_donation_matches_status");
    }

    await recordCreated(client, created);
  },

  async down(client) {
    const created = await getCreated(client);

    // Only drop objects this migration created. Objects that pre-existed
    // (e.g. from schema.sql) are left untouched, and any data they hold is
    // preserved.
    if (created.has("index:idx_donation_matches_status")) {
      await client.query("DROP INDEX IF EXISTS idx_donation_matches_status;");
    }
    if (created.has("constraint:donation_matches_status_check")) {
      await client.query(
        "ALTER TABLE donation_matches DROP CONSTRAINT IF EXISTS donation_matches_status_check;",
      );
    }
    if (created.has("column:status")) {
      await client.query("ALTER TABLE donation_matches DROP COLUMN IF EXISTS status;");
    }

    await clearCreated(client);
  },
};
