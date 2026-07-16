/**
 * src/services/idempotencyCleanup.js
 *
 * Hourly cron job that purges expired idempotency key rows from the
 * `idempotency_keys` table. Without this, keys that are used once and
 * never retried would accumulate indefinitely.
 *
 * Uses pg-boss cron scheduling (already present in the project for
 * monthly digests). Defaults to running every hour at :05 past the hour.
 *
 * The IDEMPOTENCY_CLEANUP_CRON env var can override the schedule (cron
 * syntax). Set IDEMPOTENCY_CLEANUP_CRON="disabled" to turn it off entirely.
 */
"use strict";

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");

const QUEUE = "idempotency-cleanup";
const DEFAULT_CRON = "5 * * * *"; // Every hour at :05

let boss = null;

// ── Worker logic ─────────────────────────────────────────────────────────────

async function runCleanup() {
  const result = await pool.query(
    `DELETE FROM idempotency_keys
     WHERE created_at < NOW() - INTERVAL '24 hours'`,
  );

  const deleted = result.rowCount || 0;
  if (deleted > 0) {
    logger.info(
      { event: "idempotency_cleanup", deleted },
      `Purged ${deleted} expired idempotency key(s)`,
    );
  }
}

// ── pg-boss wiring ────────────────────────────────────────────────────────────

/**
 * Start the idempotency cleanup scheduler.
 *
 * Registers a pg-boss cron job and a worker that processes it.
 */
async function start() {
  const cronOverride = process.env.IDEMPOTENCY_CLEANUP_CRON;
  if (cronOverride === "disabled") {
    logger.info(
      { event: "idempotency_cleanup_disabled" },
      "[idempotencyCleanup] Cleanup disabled via env",
    );
    return;
  }

  const cronSchedule = cronOverride || DEFAULT_CRON;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error(
      { event: "idempotency_cleanup_pgboss_error", err },
      err.message,
    ),
  );

  await boss.start();

  // Register the cron schedule (idempotent — pg-boss deduplicates by name)
  await boss.schedule(QUEUE, cronSchedule, {}, { tz: "UTC" });

  // Register the worker — single concurrency since this is a fast DELETE
  await boss.work(QUEUE, { teamSize: 1, teamConcurrency: 1 }, async () => {
    await runCleanup();
  });

  logger.info(
    { event: "idempotency_cleanup_scheduled", cron: cronSchedule },
    `[idempotencyCleanup] Cleanup scheduled: ${cronSchedule}`,
  );
}

/**
 * Gracefully stop the pg-boss instance so in-flight jobs drain.
 */
async function stop() {
  if (boss) {
    await boss.stop({ timeout: 5000 });
    boss = null;
  }
}

module.exports = { start, stop };
