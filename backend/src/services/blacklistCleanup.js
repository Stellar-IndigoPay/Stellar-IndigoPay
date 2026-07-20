/**
 * src/services/blacklistCleanup.js
 *
 * Hourly cron job that purges spent admin session rows: blacklisted access
 * token jtis and refresh tokens that are past their expiry. Neither table has
 * a natural reader that would clear them, so without this both grow forever.
 *
 * Rows are dropped on expiry rather than on revocation: a revoked refresh
 * token has to stay queryable for as long as it could still be replayed, since
 * recognising the replay is what triggers family revocation.
 *
 * The BLACKLIST_CLEANUP_CRON env var can override the schedule (cron syntax).
 * Set BLACKLIST_CLEANUP_CRON="disabled" to turn it off entirely.
 */
"use strict";

const PgBoss = require("pg-boss");
const pool = require("../db/pool");
const logger = require("../logger");

const QUEUE = "blacklist-cleanup";
const DEFAULT_CRON = "20 * * * *"; // Every hour at :20

let boss = null;

// ── Worker logic ─────────────────────────────────────────────────────────────

async function runCleanup() {
  const blacklisted = await pool.query(
    "DELETE FROM token_blacklist WHERE expires_at < NOW()",
  );
  const refreshed = await pool.query(
    "DELETE FROM refresh_tokens WHERE expires_at < NOW()",
  );

  const deletedJtis = blacklisted.rowCount || 0;
  const deletedTokens = refreshed.rowCount || 0;
  if (deletedJtis > 0 || deletedTokens > 0) {
    logger.info(
      { event: "blacklist_cleanup", deletedJtis, deletedTokens },
      `Purged ${deletedJtis} blacklisted jti(s) and ${deletedTokens} expired refresh token(s)`,
    );
  }
}

// ── pg-boss wiring ────────────────────────────────────────────────────────────

/**
 * Start the admin session cleanup scheduler.
 *
 * Registers a pg-boss cron job and a worker that processes it.
 */
async function start() {
  const cronOverride = process.env.BLACKLIST_CLEANUP_CRON;
  if (cronOverride === "disabled") {
    logger.info(
      { event: "blacklist_cleanup_disabled" },
      "[blacklistCleanup] Cleanup disabled via env",
    );
    return;
  }

  const cronSchedule = cronOverride || DEFAULT_CRON;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  boss = new PgBoss(connectionString);
  boss.on("error", (err) =>
    logger.error({ event: "blacklist_cleanup_pgboss_error", err }, err.message),
  );

  await boss.start();

  // Register the cron schedule (idempotent — pg-boss deduplicates by name)
  await boss.schedule(QUEUE, cronSchedule, {}, { tz: "UTC" });

  // Register the worker — single concurrency since these are fast DELETEs
  await boss.work(QUEUE, { teamSize: 1, teamConcurrency: 1 }, async () => {
    await runCleanup();
  });

  logger.info(
    { event: "blacklist_cleanup_scheduled", cron: cronSchedule },
    `[blacklistCleanup] Cleanup scheduled: ${cronSchedule}`,
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
