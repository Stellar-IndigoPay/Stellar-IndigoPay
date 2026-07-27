"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const pool = require("./pool");
const { seedProjects, seedProjectUpdates, seedJobs } = require("../services/store");

const MIGRATIONS_DIR = path.join(__dirname, "../../migrations");
const HISTORY_TABLE = "_migrations";

function parseMigration(filePath) {
  const content = fs.readFileSync(filePath, "utf8");

  const upMatch = content.match(/--\s*UP\s*\n([\s\S]*?)(?:\n--\s*DOWN\s*\n|\n--\s*DOWN\s*$|$)/i);
  const downMatch = content.match(/--\s*DOWN\s*\n([\s\S]*)/i);
const {
  seedProjects,
  seedProjectUpdates,
  seedJobs,
} = require("../services/store");
const { lintMigrations } = require("../../scripts/validate-migrations");

  const up = upMatch?.[1]?.trim();
  const down = downMatch?.[1]?.trim();

  return { up, down };
}

async function ensureHistoryTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE} (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      checksum TEXT NOT NULL
    )
  `);
}

async function getAppliedMigrations(client) {
  const result = await client.query(
    `SELECT id, name, applied_at, checksum FROM ${HISTORY_TABLE} ORDER BY id ASC`,
  );
  return result.rows;
}

function loadSqlMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b))
    .map((file) => path.join(MIGRATIONS_DIR, file));
}

async function runMigrations({ dryRun = false } = {}) {
  const lintResult = lintMigrations();
  if (lintResult.issues.length > 0) {
    throw new Error(
      `Migration policy violations detected: ${lintResult.issues
        .map((issue) => `${issue.rule}:${issue.file}`)
        .join(", ")}`,
    );
  }

  const client = await pool.connect();
  try {
    await ensureHistoryTable(client);

    const appliedRows = await getAppliedMigrations(client);
    const appliedSet = new Set(appliedRows.map((r) => r.name));

    const migrationPaths = loadSqlMigrationFiles();

    for (const migrationPath of migrationPaths) {
      const fileName = path.basename(migrationPath);
      if (appliedSet.has(fileName)) continue;

      const { up } = parseMigration(migrationPath);
      if (!up) continue;

      const checksum = crypto.createHash("sha256").update(up).digest("hex");

      await client.query("BEGIN");
      try {
        await client.query(up);
        await client.query(
          `INSERT INTO ${HISTORY_TABLE} (name, checksum) VALUES ($1, $2)`,
          [fileName, checksum],
        );
        await client.query("COMMIT");
        // eslint-disable-next-line no-console
        console.log(`[DB] Applied migration: ${fileName}`);
      } catch (err) {
        await client.query("ROLLBACK");
        // eslint-disable-next-line no-console
        console.error(`[DB] Migration failed: ${fileName}: ${err.message}`);
        throw err;
      }
    }
  } finally {
    client.release();
  }

  await seedDatabase();
  // eslint-disable-next-line no-console
  console.log("[DB] Migration complete");
}

async function getMigrationStatus() {
  const client = await pool.connect();
  try {
    await ensureHistoryTable(client);
    const rows = await getAppliedMigrations(client);
    return rows;
  } finally {
    client.release();
  }
}

async function rollbackMigration({ name, steps = 1 } = {}) {
  const client = await pool.connect();
  try {
    await ensureHistoryTable(client);

    let rows;
    if (name) {
      rows = await client.query(
        `SELECT id, name, applied_at, checksum FROM ${HISTORY_TABLE} WHERE name = $1 ORDER BY id DESC`,
        [name],
      );
      rows = rows.rows;
      if (rows.length === 0) return;
    } else {
      const safeSteps = Number(steps) || 1;
      rows = await client.query(
        `SELECT id, name, applied_at, checksum FROM ${HISTORY_TABLE} ORDER BY id DESC LIMIT $1`,
        [safeSteps],
      );
      rows = rows.rows;
      if (rows.length === 0) return;
    }

    // Roll back newest-first.
    for (const row of rows) {
      const migrationPath = path.join(MIGRATIONS_DIR, row.name);
      if (!fs.existsSync(migrationPath)) {
        throw new Error(`Migration file not found for rollback: ${migrationPath}`);
      }

      const { down } = parseMigration(migrationPath);
      if (!down) {
        throw new Error(`No DOWN migration for ${row.name}`);
      }

      await client.query("BEGIN");
      try {
        await client.query(down);
        await client.query(`DELETE FROM ${HISTORY_TABLE} WHERE name = $1`, [row.name]);
        await client.query("COMMIT");
        // eslint-disable-next-line no-console
        console.log(`[DB] Rolled back migration: ${row.name}`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    client.release();
  }
}

async function seedDatabase() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    for (const project of seedProjects) {
      await client.query(
        `INSERT INTO projects (
          id, name, description, category, location, wallet_address, goal_xlm,
          raised_xlm, donor_count, co2_offset_kg, status, verified, on_chain_verified,
          tags, created_at, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, $10, $11, $12, $13,
          $14, $15, $16
        )
        ON CONFLICT (id) DO NOTHING`,
        [
          project.id,
          project.name,
          project.description,
          project.category,
          project.location,
          project.walletAddress,
          project.goalXLM,
          project.raisedXLM,
          project.donorCount,
          project.co2OffsetKg,
          project.status,
          project.verified,
          project.onChainVerified,
          project.tags,
          project.createdAt,
          project.updatedAt,
        ],
      );
    }

    for (const update of seedProjectUpdates) {
      await client.query(
        `INSERT INTO project_updates (id, project_id, title, body, created_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id) DO NOTHING`,
        [update.id, update.projectId, update.title, update.body, update.createdAt],
      );
    }

    for (const job of seedJobs) {
      await client.query(
        `INSERT INTO jobs (
          id, title, description, client_public_key, freelancer_public_key,
          amount_escrow_xlm, status, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (id) DO NOTHING`,
        [
          job.id,
          job.title,
          job.description,
          job.clientPublicKey,
          job.freelancerPublicKey,
          job.amountEscrowXlm,
          job.status,
          job.createdAt,
          job.updatedAt,
        ],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  runMigrations,
  rollbackMigration,
  getMigrationStatus,
};


