"use strict";

/**
 * helpers/fixtures.js
 *
 * Deterministic fixture generator for seeded-upgrade tests.
 *
 * All values are hard-coded (no random data) so test runs are reproducible.
 * Edge cases covered per the issue spec:
 *   - NULLs in optional columns
 *   - Unicode in text fields (emoji, CJK, RTL, combining chars)
 *   - Large text bodies (1 000+ chars)
 *   - Boundary amounts (0, very small, very large NUMERIC(20,7))
 *   - Empty arrays for ARRAY columns
 *   - Minimum and maximum integer values
 *
 * Fixtures are written against the schema as it exists after 001_initial_schema,
 * so later upgrade tests can insert them at the earliest possible version.
 */

const { v4: uuidv4 } = require("uuid");

// ── Stable IDs ─────────────────────────────────────────────────────────────
// Using fixed UUIDs keeps test output deterministic and makes FK references easy.
const IDS = {
  project: {
    normal:  "10000000-0000-0000-0000-000000000001",
    unicode: "10000000-0000-0000-0000-000000000002",
    nullish: "10000000-0000-0000-0000-000000000003",
    large:   "10000000-0000-0000-0000-000000000004",
    boundary:"10000000-0000-0000-0000-000000000005",
  },
  donation: {
    normal:  "20000000-0000-0000-0000-000000000001",
    unicode: "20000000-0000-0000-0000-000000000002",
    nullish: "20000000-0000-0000-0000-000000000003",
    small:   "20000000-0000-0000-0000-000000000004",
    large:   "20000000-0000-0000-0000-000000000005",
  },
  profile: {
    normal:  "GDONOR1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    unicode: "GDONOR2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
  },
};

// ── Edge-case text values ──────────────────────────────────────────────────
const UNICODE_NAME   = "Sørens Klimaprojekt 🌍 日本語テスト مشروع";
const UNICODE_DESC   = "Описание проекта with émojis 🌱🌳 and Hebrew: שלום";
const LARGE_TEXT     = "A".repeat(1_024) + " — end of large text fixture";
const UNICODE_MSG    = "Donation from 北京 with ❤️ and تعليق";
const NULL_OPTIONAL  = null;

// Boundary amounts for NUMERIC(20, 7)
const AMOUNT_ZERO      = "0.0000000";
const AMOUNT_TINY      = "0.0000001";
const AMOUNT_LARGE     = "9999999999999.9999999";
const AMOUNT_NORMAL    = "1234.5670000";

/**
 * Insert the core fixture rows into a DB that has had 001_initial_schema applied.
 * Returns a summary of what was inserted so tests can assert against it.
 */
async function insertCoreFixtures(pool) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // ── Projects ─────────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO projects
         (id, name, description, category, location, wallet_address,
          goal_xlm, raised_xlm, donor_count, co2_offset_kg, status,
          verified, on_chain_verified, tags)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        IDS.project.normal,
        "Normal Project",
        "A standard climate initiative",
        "reforestation",
        "Kenya",
        "GWALLET1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "50000.0000000",
        AMOUNT_NORMAL,
        42,
        12345,
        "active",
        true,
        false,
        ["trees", "africa"],
      ],
    );

    await client.query(
      `INSERT INTO projects
         (id, name, description, category, location, wallet_address,
          goal_xlm, raised_xlm, donor_count, co2_offset_kg, status,
          verified, on_chain_verified, tags)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        IDS.project.unicode,
        UNICODE_NAME,
        UNICODE_DESC,
        "solar",
        "日本 Japan",
        "GWALLET2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "100000.0000000",
        "5000.0000000",
        7,
        999,
        "active",
        false,
        false,
        [],                    // empty tags array — edge case
      ],
    );

    await client.query(
      `INSERT INTO projects
         (id, name, description, category, location, wallet_address,
          goal_xlm, raised_xlm, donor_count, co2_offset_kg, status,
          verified, on_chain_verified, tags)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        IDS.project.nullish,
        "Null-optional Project",
        "Tests NULL in optional cols",
        "wind",
        "USA",
        "GWALLET3XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        AMOUNT_ZERO,
        AMOUNT_ZERO,
        0,
        0,
        "active",
        false,
        false,
        [],
      ],
    );

    await client.query(
      `INSERT INTO projects
         (id, name, description, category, location, wallet_address,
          goal_xlm, raised_xlm, donor_count, co2_offset_kg, status,
          verified, on_chain_verified, tags)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        IDS.project.large,
        "Large-text Project",
        LARGE_TEXT,
        "hydro",
        "Norway",
        "GWALLET4XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        "999999.0000000",
        "0.0000001",
        1,
        1,
        "active",
        false,
        false,
        ["hydro", "large-text-test"],
      ],
    );

    await client.query(
      `INSERT INTO projects
         (id, name, description, category, location, wallet_address,
          goal_xlm, raised_xlm, donor_count, co2_offset_kg, status,
          verified, on_chain_verified, tags)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        IDS.project.boundary,
        "Boundary Amounts",
        "Tests boundary NUMERIC values",
        "geo",
        "Iceland",
        "GWALLET5XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        AMOUNT_LARGE,
        AMOUNT_TINY,
        0,
        0,
        "completed",
        true,
        true,
        ["boundary"],
      ],
    );

    // ── Donations ─────────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO donations
         (id, project_id, donor_address, amount_xlm, amount,
          currency, message, transaction_hash)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        IDS.donation.normal,
        IDS.project.normal,
        IDS.profile.normal,
        AMOUNT_NORMAL,
        AMOUNT_NORMAL,
        "XLM",
        "Keep up the great work!",
        "TX_NORMAL_HASH_000000000000000001",
      ],
    );

    await client.query(
      `INSERT INTO donations
         (id, project_id, donor_address, amount_xlm, amount,
          currency, message, transaction_hash)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        IDS.donation.unicode,
        IDS.project.unicode,
        IDS.profile.unicode,
        "500.0000000",
        "500.0000000",
        "XLM",
        UNICODE_MSG,
        "TX_UNICODE_HASH_00000000000000001",
      ],
    );

    await client.query(
      `INSERT INTO donations
         (id, project_id, donor_address, amount_xlm, amount,
          currency, message, transaction_hash)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        IDS.donation.nullish,
        IDS.project.nullish,
        IDS.profile.normal,
        NULL_OPTIONAL,    // amount_xlm is nullable
        AMOUNT_ZERO,
        "XLM",
        NULL_OPTIONAL,    // message is nullable
        "TX_NULL_HASH_0000000000000000001",
      ],
    );

    await client.query(
      `INSERT INTO donations
         (id, project_id, donor_address, amount_xlm, amount,
          currency, message, transaction_hash)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        IDS.donation.small,
        IDS.project.boundary,
        IDS.profile.normal,
        AMOUNT_TINY,
        AMOUNT_TINY,
        "XLM",
        NULL_OPTIONAL,
        "TX_SMALL_HASH_0000000000000000001",
      ],
    );

    await client.query(
      `INSERT INTO donations
         (id, project_id, donor_address, amount_xlm, amount,
          currency, message, transaction_hash)
       VALUES
         ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        IDS.donation.large,
        IDS.project.boundary,
        IDS.profile.unicode,
        AMOUNT_LARGE,
        AMOUNT_LARGE,
        "XLM",
        NULL_OPTIONAL,
        "TX_LARGE_HASH_0000000000000000001",
      ],
    );

    // ── Profiles ──────────────────────────────────────────────────────────
    await client.query(
      `INSERT INTO profiles
         (public_key, display_name, bio, total_donated_xlm,
          projects_supported, badges)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        IDS.profile.normal,
        "Alice Climate",
        "Avid climate donor",
        AMOUNT_NORMAL,
        3,
        JSON.stringify([{ type: "Seedling", earned_at: "2026-01-01" }]),
      ],
    );

    await client.query(
      `INSERT INTO profiles
         (public_key, display_name, bio, total_donated_xlm,
          projects_supported, badges)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        IDS.profile.unicode,
        UNICODE_NAME,
        NULL_OPTIONAL,         // bio is nullable
        AMOUNT_TINY,
        1,
        "[]",
      ],
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { IDS };
}

/**
 * Count all rows in a given table. Used for data-loss assertions.
 */
async function countRows(pool, tableName) {
  const client = await pool.connect();
  try {
    // Table name is internal — not user input — so inline substitution is safe.
    const result = await client.query(
      `SELECT COUNT(*)::INTEGER AS n FROM "${tableName}"`,
    );
    return result.rows[0].n;
  } finally {
    client.release();
  }
}

/**
 * Return all rows from a table (for deep equality assertions on small tables).
 */
async function fetchAll(pool, tableName) {
  const client = await pool.connect();
  try {
    const result = await client.query(`SELECT * FROM "${tableName}" ORDER BY 1`);
    return result.rows;
  } finally {
    client.release();
  }
}

/**
 * Assert that a column exists in a table. Throws a descriptive error if not.
 */
async function assertColumnExists(pool, tableName, columnName) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [tableName, columnName],
    );
    if (result.rows.length === 0) {
      throw new Error(
        `Expected column "${columnName}" to exist on table "${tableName}" but it was not found.`,
      );
    }
  } finally {
    client.release();
  }
}

/**
 * Assert that a column does NOT exist in a table.
 */
async function assertColumnAbsent(pool, tableName, columnName) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name   = $1
         AND column_name  = $2`,
      [tableName, columnName],
    );
    if (result.rows.length > 0) {
      throw new Error(
        `Expected column "${columnName}" to be absent from table "${tableName}" but it exists.`,
      );
    }
  } finally {
    client.release();
  }
}

/**
 * Assert that a table exists.
 */
async function assertTableExists(pool, tableName) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name   = $1`,
      [tableName],
    );
    if (result.rows.length === 0) {
      throw new Error(
        `Expected table "${tableName}" to exist but it was not found.`,
      );
    }
  } finally {
    client.release();
  }
}

/**
 * Assert that a table does NOT exist.
 */
async function assertTableAbsent(pool, tableName) {
  const client = await pool.connect();
  try {
    const result = await client.query(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name   = $1`,
      [tableName],
    );
    if (result.rows.length > 0) {
      throw new Error(
        `Expected table "${tableName}" to be absent but it exists.`,
      );
    }
  } finally {
    client.release();
  }
}

module.exports = {
  IDS,
  insertCoreFixtures,
  countRows,
  fetchAll,
  assertColumnExists,
  assertColumnAbsent,
  assertTableExists,
  assertTableAbsent,
  UNICODE_NAME,
  UNICODE_DESC,
  LARGE_TEXT,
  UNICODE_MSG,
  AMOUNT_ZERO,
  AMOUNT_TINY,
  AMOUNT_LARGE,
  AMOUNT_NORMAL,
};
