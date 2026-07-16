#!/usr/bin/env node

/**
 * verify-backup.js — Postgres backup integrity verification
 *
 * Usage:
 *   node backend/scripts/verify-backup.js --backup /path/to/backup.sql
 *   node backend/scripts/verify-backup.js --backup /path/to/backup.sql.gz
 *
 * Outputs a JSON report to stdout. Exits 0 on pass, 1 on any failing check.
 *
 * Checks performed:
 *   1. File existence & non-zero size
 *   2. SHA-256 checksum
 *   3. Restore into a temporary Postgres 16 container
 *   4. Critical table existence (projects, donations, profiles, etc.)
 *   5. Minimum row counts on key tables
 *   6. Foreign-key consistency (orphaned donations → projects)
 *   7. Temp container is torn down regardless of pass/fail
 */

"use strict";

const { execSync } = require("child_process");
const fs = require("fs");
const crypto = require("crypto");
const path = require("path");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CRITICAL_TABLES = [
  "projects",
  "donations",
  "profiles",
  "verification_requests",
  "donation_matches",
];

const MIN_ROW_COUNTS = {
  projects: 1,
  donations: 0,
  profiles: 0,
};

const DOCKER_IMAGE = "postgres:16-alpine";
const CONTAINER_NAME = "verify-pg";
const DB_NAME = "indigopay_verify";
const PG_USER = "postgres";
const PG_PASSWORD = "verifytest";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a shell command, returning trimmed stdout. Throws on non-zero exit.
 * @param {string} cmd
 * @param {{ ignoreError?: boolean }} [opts]
 * @returns {string}
 */
function run(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    }).trim();
  } catch (err) {
    if (opts.ignoreError) {
      return "";
    }
    throw err;
  }
}

/**
 * Decompress a .gz file to a destination path using gunzip.
 * @param {string} src
 * @param {string} dest
 */
function gunzipFile(src, dest) {
  const zlib = require("zlib");
  const compressed = fs.readFileSync(src);
  const decompressed = zlib.gunzipSync(compressed);
  fs.writeFileSync(dest, decompressed);
}

// ---------------------------------------------------------------------------
// Core verification
// ---------------------------------------------------------------------------

/**
 * @typedef {{
 *   name: string,
 *   passed: boolean,
 *   detail?: string
 * }} CheckResult
 *
 * @typedef {{
 *   timestamp: string,
 *   backup: string,
 *   checks: CheckResult[],
 *   passed: boolean,
 *   error?: string,
 *   checksum?: string,
 *   durationMs: number
 * }} VerificationReport
 */

/**
 * Verify a Postgres backup file.
 * @param {string} backupPath
 * @returns {VerificationReport}
 */
function verifyBackup(backupPath) {
  const start = Date.now();
  const report = {
    timestamp: new Date().toISOString(),
    backup: backupPath,
    checks: [],
    passed: false,
    durationMs: 0,
  };

  try {
    // ---- 1. File existence & non-zero size --------------------------------
    let stats;
    try {
      stats = fs.statSync(backupPath);
    } catch {
      return fail(report, `Backup file not found: ${backupPath}`, start);
    }

    report.checks.push({
      name: "file_exists",
      passed: stats.size > 0,
      detail: `File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`,
    });

    if (stats.size === 0) {
      return fail(report, "Empty backup file (size = 0)", start);
    }

    // ---- 2. SHA-256 checksum ----------------------------------------------
    const fileBuffer = fs.readFileSync(backupPath);
    const checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");
    report.checksum = checksum;
    report.checks.push({
      name: "checksum",
      passed: true,
      detail: checksum,
    });

    // ---- 3. Determine if we need to decompress ----------------------------
    let sqlPath = backupPath;
    if (backupPath.endsWith(".gz")) {
      sqlPath = backupPath.replace(/\.gz$/, "");
      gunzipFile(backupPath, sqlPath);
    }

    // ---- 4. Spin up temporary Postgres container --------------------------
    try {
      run(`docker rm -f ${CONTAINER_NAME} 2>/dev/null || true`, { ignoreError: true });
      run(
        `docker run -d --name ${CONTAINER_NAME} ` +
          `-e POSTGRES_PASSWORD=${PG_PASSWORD} ` +
          `-e POSTGRES_DB=${DB_NAME} ` +
          `${DOCKER_IMAGE}`
      );

      // Wait for Postgres readiness
      let ready = false;
      for (let i = 0; i < 30; i++) {
        try {
          const status = run(
            `docker exec ${CONTAINER_NAME} pg_isready -U ${PG_USER} -q && echo "ready" || echo "waiting"`,
            { ignoreError: true }
          );
          if (status.includes("ready")) {
            ready = true;
            break;
          }
        } catch {
          // pg_isready not ready yet
        }
        run("sleep 1");
      }

      if (!ready) {
        return fail(report, "Temporary Postgres container did not become ready", start);
      }

      // ---- 5. Restore backup into temp DB ---------------------------------
      // Read SQL content and pipe via stdin to avoid shell injection via path
      const sqlContent = fs.readFileSync(sqlPath, "utf-8");
      const restoreProc = require("child_process").spawnSync("docker", [
        "exec", "-i", CONTAINER_NAME, "psql",
        "-U", PG_USER, "-d", DB_NAME,
      ], { input: sqlContent, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 });
      if (restoreProc.status !== 0) {
        throw new Error(`psql restore failed: ${restoreProc.stderr || restoreProc.error || "unknown error"}`);
      }

      // ---- 6. Verify critical tables exist --------------------------------
      for (const table of CRITICAL_TABLES) {
        const result = run(
          `docker exec ${CONTAINER_NAME} psql ` +
            `-U ${PG_USER} -d ${DB_NAME} ` +
            `-tAc "SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = '${table}')"`
        );
        const exists = result === "t";
        report.checks.push({
          name: `table_${table}_exists`,
          passed: exists,
          detail: exists ? "exists" : "missing",
        });
      }

      // ---- 7. Row count assertions ----------------------------------------
      for (const [table, minCount] of Object.entries(MIN_ROW_COUNTS)) {
        try {
          const count = parseInt(
            run(
              `docker exec ${CONTAINER_NAME} psql ` +
                `-U ${PG_USER} -d ${DB_NAME} ` +
                `-tAc "SELECT COUNT(*) FROM ${table}"`
            ),
            10
          );
          report.checks.push({
            name: `table_${table}_row_count`,
            passed: count >= minCount,
            detail: `${count} rows (min: ${minCount})`,
          });
        } catch {
          report.checks.push({
            name: `table_${table}_row_count`,
            passed: false,
            detail: "table not found or query failed",
          });
        }
      }

      // ---- 8. Foreign-key consistency check -------------------------------
      const orphanDonations = run(
        `docker exec ${CONTAINER_NAME} psql ` +
          `-U ${PG_USER} -d ${DB_NAME} ` +
          "-tAc \"SELECT COUNT(*) FROM donations d LEFT JOIN projects p ON d.project_id = p.id WHERE p.id IS NULL\""
      );
      report.checks.push({
        name: "foreign_key_donations_projects",
        passed: parseInt(orphanDonations, 10) === 0,
        detail: `${orphanDonations} orphaned donations`,
      });

    } finally {
      // ---- 9. Cleanup: always remove temp container -----------------------
      try {
        run(`docker rm -f ${CONTAINER_NAME}`, { ignoreError: true });
      } catch {
        // Best-effort cleanup
      }

      // Remove decompressed file if we created one
      if (sqlPath !== backupPath) {
        try {
          fs.unlinkSync(sqlPath);
        } catch {
          // Best-effort cleanup
        }
      }
    }

    // ---- 10. Overall pass/fail --------------------------------------------
    report.passed = report.checks.every((c) => c.passed);
  } catch (err) {
    return fail(report, `Unexpected error: ${err.message}`, start);
  }

  report.durationMs = Date.now() - start;
  return report;
}

/**
 * Mark report as failed and return it.
 * @param {VerificationReport} report
 * @param {string} reason
 * @param {number} start
 * @returns {VerificationReport}
 */
function fail(report, reason, start) {
  report.passed = false;
  report.error = reason;
  report.durationMs = Date.now() - start;
  return report;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (require.main === module) {
  const args = process.argv.slice(2);
  const backupIdx = args.indexOf("--backup");

  if (backupIdx === -1 || backupIdx + 1 >= args.length) {
    console.error("Usage: node backend/scripts/verify-backup.js --backup <path>");
    process.exit(2);
  }

  const backupPath = path.resolve(args[backupIdx + 1]);
  const report = verifyBackup(backupPath);

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.passed ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

module.exports = { verifyBackup, CRITICAL_TABLES, MIN_ROW_COUNTS };
