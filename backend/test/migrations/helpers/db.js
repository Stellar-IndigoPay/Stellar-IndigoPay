"use strict";

/**
 * helpers/db.js
 *
 * Boots a disposable PostgreSQL container for the migration harness.
 * Uses @testcontainers/postgresql so each test suite gets an isolated,
 * ephemeral database — no production data ever touches the harness.
 *
 * Usage:
 *   const { startDb, stopDb, newPool } = require('./helpers/db');
 *   const { container, pool } = await startDb();
 *   // ... run tests ...
 *   await stopDb(container, pool);
 */

const { PostgreSqlContainer } = require("@testcontainers/postgresql");
const { Pool } = require("pg");

const PG_IMAGE = "postgres:16-alpine";
const CONNECT_TIMEOUT_MS = 120_000;

/**
 * Start a throwaway Postgres container and return { container, pool }.
 * The caller must call stopDb() in afterAll to free resources.
 */
async function startDb() {
  const container = await new PostgreSqlContainer(PG_IMAGE)
    .withStartupTimeout(CONNECT_TIMEOUT_MS)
    .start();

  const connectionUri = container.getConnectionUri();

  const pool = new Pool({
    connectionString: connectionUri,
    max: 5,
    idleTimeoutMillis: 5_000,
  });

  // Verify connectivity
  const client = await pool.connect();
  await client.query("SELECT 1");
  client.release();

  return { container, pool, connectionUri };
}

/**
 * Tear down the pool and stop the container.
 */
async function stopDb(container, pool) {
  try {
    await pool.end();
  } catch (_) {
    // ignore
  }
  try {
    await container.stop({ timeout: 10_000 });
  } catch (_) {
    // ignore
  }
}

/**
 * Return a fresh client from the pool (caller must release it).
 */
async function getClient(pool) {
  return pool.connect();
}

/**
 * Introspect the live schema and return a normalised snapshot:
 *   { tables, columns, indexes, constraints }
 *
 * Used by the parity checker to compare the migration-chain result
 * against the checked-in schema.sql.
 */
async function snapshotSchema(pool) {
  const client = await pool.connect();
  try {
    const [tables, columns, indexes, constraints] = await Promise.all([
      client.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_type = 'BASE TABLE'
        ORDER BY table_name
      `),
      client.query(`
        SELECT table_name, column_name, data_type,
               is_nullable, column_default
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position
      `),
      client.query(`
        SELECT indexname, tablename, indexdef
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname NOT LIKE 'pg_%'
        ORDER BY tablename, indexname
      `),
      client.query(`
        SELECT tc.table_name, tc.constraint_name, tc.constraint_type,
               kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
         AND tc.table_schema    = kcu.table_schema
        WHERE tc.table_schema = 'public'
          AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE','CHECK','FOREIGN KEY')
        ORDER BY tc.table_name, tc.constraint_name, kcu.ordinal_position
      `),
    ]);

    return {
      tables: tables.rows.map((r) => r.table_name).sort(),
      columns: columns.rows,
      indexes: indexes.rows,
      constraints: constraints.rows,
    };
  } finally {
    client.release();
  }
}

module.exports = { startDb, stopDb, getClient, snapshotSchema };
