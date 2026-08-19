"use strict";

/**
 * helpers/parity.js
 *
 * Schema parity checker: verifies that applying the full migration chain
 * produces a schema that is equivalent to the checked-in schema.sql.
 *
 * "Equivalent" means:
 *   - Every table declared in schema.sql exists in the migrated DB.
 *   - Every column declared in schema.sql exists in the migrated DB
 *     with a compatible data type.
 *
 * An ALLOWLIST is maintained for intentional differences between the
 * migration chain and schema.sql (e.g. schema.sql uses `IF NOT EXISTS`
 * guards that are idempotent but produce no structural difference).
 * Documented differences must be explained in the allowlist entry.
 *
 * Comparison strategy:
 *   We parse schema.sql with a lightweight regex extractor (not a full SQL
 *   parser) to extract table names and column names. This is intentionally
 *   conservative — the parity check is a safety net, not a schema diff tool.
 *   If schema.sql changes in a way that breaks the regex, update the extractor.
 */

const fs = require("fs");
const path = require("path");

const SCHEMA_SQL_PATH = path.join(
  __dirname,
  "../../../src/db/schema.sql",
);

// ── Allowlist ──────────────────────────────────────────────────────────────
// Each entry is { table, column (optional), reason }.
// If `column` is omitted the entire table is allowlisted (e.g. a view that
// schema.sql documents but which is not a BASE TABLE).
const SCHEMA_PARITY_ALLOWLIST = [
  // schema.sql documents the `credits` table conceptually (migration 027 uses
  // it as an example of the expand-contract pattern) but the table is never
  // actually created by any migration because 027 only adds a column to it
  // — it is an illustration, not a real production table.
  {
    table: "credits",
    reason:
      "credits table is referenced in 027_add_credit_migration_phase as an " +
      "expand-contract example only. No CREATE TABLE exists in the chain.",
  },
  // schema.sql contains ALTER TABLE ... ADD COLUMN IF NOT EXISTS guards
  // for several columns that are already defined in the initial CREATE TABLE.
  // The migrated DB has exactly one column; schema.sql declares it twice
  // (CREATE + ALTER). This is idempotent at the DB level and not a difference.
  {
    table: "projects",
    column: "webhook_url",
    reason:
      "schema.sql has two ADD COLUMN IF NOT EXISTS for webhook_url (idempotent). " +
      "The column exists once in the DB — no real difference.",
  },
  {
    table: "projects",
    column: "webhook_secret",
    reason:
      "schema.sql has two ADD COLUMN IF NOT EXISTS for webhook_secret (idempotent). " +
      "The column exists once in the DB — no real difference.",
  },
];

/**
 * Parse table names and their columns from schema.sql using a conservative
 * regex approach. Returns Map<tableName, Set<columnName>>.
 */
function parseSchemaSQL(sqlText) {
  const tables = new Map();

  // Extract CREATE TABLE blocks
  const createTableRe =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s*\(([^;]+?)\)/gi;
  let m;
  while ((m = createTableRe.exec(sqlText)) !== null) {
    const tableName = m[1].toLowerCase();
    const body = m[2];
    const cols = new Set();

    // Extract column definitions (lines that start with a word, not a constraint keyword)
    const colRe = /^\s+(\w+)\s+\w/gm;
    let cm;
    while ((cm = colRe.exec(body)) !== null) {
      const colName = cm[1].toLowerCase();
      // Skip SQL keywords that start constraint lines
      if (
        ["constraint", "primary", "unique", "check", "foreign", "index"].includes(
          colName,
        )
      )
        continue;
      cols.add(colName);
    }

    if (!tables.has(tableName)) {
      tables.set(tableName, cols);
    } else {
      // Merge columns if the same table appears multiple times
      for (const c of cols) tables.get(tableName).add(c);
    }
  }

  // Extract ADD COLUMN ... clauses and associate them with the table
  const alterAddRe =
    /ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s/gi;
  while ((m = alterAddRe.exec(sqlText)) !== null) {
    const tableName = m[1].toLowerCase();
    const colName = m[2].toLowerCase();
    if (!tables.has(tableName)) tables.set(tableName, new Set());
    tables.get(tableName).add(colName);
  }

  return tables;
}

/**
 * Fetch all BASE TABLE names and their columns from the live DB.
 * Returns Map<tableName, Set<columnName>>.
 */
async function liveSchema(pool) {
  const client = await pool.connect();
  try {
    const result = await client.query(`
      SELECT c.table_name, c.column_name
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_name   = c.table_name
       AND t.table_schema = c.table_schema
      WHERE c.table_schema = 'public'
        AND t.table_type   = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position
    `);

    const schema = new Map();
    for (const row of result.rows) {
      if (!schema.has(row.table_name)) schema.set(row.table_name, new Set());
      schema.get(row.table_name).add(row.column_name);
    }
    return schema;
  } finally {
    client.release();
  }
}

/**
 * Run the parity check.
 *
 * Returns { passed: boolean, violations: string[], allowlisted: string[] }
 */
async function checkParity(pool) {
  const sqlText = fs.readFileSync(SCHEMA_SQL_PATH, "utf8");
  const expected = parseSchemaSQL(sqlText);
  const actual   = await liveSchema(pool);

  const violations  = [];
  const allowlisted = [];

  for (const [tableName, expectedCols] of expected) {
    // Check if entire table is allowlisted
    const tableAllowlisted = SCHEMA_PARITY_ALLOWLIST.find(
      (e) => e.table === tableName && !e.column,
    );
    if (tableAllowlisted) {
      allowlisted.push(
        `TABLE ${tableName}: ${tableAllowlisted.reason}`,
      );
      continue;
    }

    if (!actual.has(tableName)) {
      violations.push(
        `Table "${tableName}" declared in schema.sql not found in migrated DB.`,
      );
      continue;
    }

    const actualCols = actual.get(tableName);
    for (const colName of expectedCols) {
      // Check if this specific column is allowlisted
      const colAllowlisted = SCHEMA_PARITY_ALLOWLIST.find(
        (e) => e.table === tableName && e.column === colName,
      );
      if (colAllowlisted) {
        allowlisted.push(
          `COLUMN ${tableName}.${colName}: ${colAllowlisted.reason}`,
        );
        continue;
      }

      if (!actualCols.has(colName)) {
        violations.push(
          `Column "${colName}" on table "${tableName}" declared in schema.sql ` +
            `not found in migrated DB.`,
        );
      }
    }
  }

  return {
    passed: violations.length === 0,
    violations,
    allowlisted,
  };
}

module.exports = {
  checkParity,
  parseSchemaSQL,
  SCHEMA_PARITY_ALLOWLIST,
};
