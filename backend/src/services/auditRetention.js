"use strict";

/**
 * src/services/auditRetention.js
 *
 * Audit-log retention policy.
 *
 * Because native monthly partitioning (migration 012) is optional and not
 * guaranteed to be present in every deployment, this module implements a
 * SAFE, partition-agnostic retention: it DELETES rows older than
 * `retentionMonths` from `admin_audit_log`.
 *
 * Safety:
 *   - The destructive delete is GUARDED behind the env flag
 *     AUDIT_LOG_RETENTION_ENABLED=true. Default is false so tests and
 *     accidental invocations never delete data.
 *   - `retentionMonths` defaults to AUDIT_LOG_RETENTION_MONTHS (or 12).
 *   - The threshold uses server-side `now() - interval` so it's timezone-safe.
 *
 * pg-boss wiring (optional):
 *   pg-boss IS present in this repo. To schedule retention as a recurring job,
 *   pass an already-started `PgBoss` instance to `registerRetentionJob(boss)`
 *   and enqueue/await `enqueueRetentionJob()` from your scheduler bootstrap.
 *   We deliberately do NOT create a new pg-boss singleton here — callers wire
 *   it into the existing boss to avoid duplicate connections.
 */

const logger = require("../logger");

/**
 * Delete audit rows older than `retentionMonths`.
 *
 * @param {Object} client - pg client / pool with `.query()`
 * @param {number} [retentionMonths] - override; defaults to env or 12
 * @returns {Promise<{ enabled: boolean, deleted: number }>}
 */
async function dropOldPartitions(
  client,
  retentionMonths = Number(process.env.AUDIT_LOG_RETENTION_MONTHS) || 12,
) {
  const enabled = process.env.AUDIT_LOG_RETENTION_ENABLED === "true";

  if (!enabled) {
    logger.info(
      { event: "audit_retention_skipped", reason: "disabled" },
      "[auditRetention] Retention disabled (AUDIT_LOG_RETENTION_ENABLED != true)",
    );
    return { enabled: false, deleted: 0 };
  }

  const months = Number.isFinite(retentionMonths)
    ? retentionMonths
    : 12;

  const result = await client.query(
    `DELETE FROM admin_audit_log
     WHERE created_at < now() - ($1::int || ' months')::interval`,
    [months],
  );

  const deleted = result.rowCount ?? 0;
  logger.info(
    { event: "audit_retention_run", months, deleted },
    `[auditRetention] Deleted ${deleted} audit row(s) older than ${months} month(s)`,
  );
  return { enabled: true, deleted };
}

const RETENTION_JOB_NAME = "audit-log-retention";

/**
 * Register a pg-boss worker that runs retention on demand.
 * Pass an already-started PgBoss instance (e.g. from digestQueue/profileQueue).
 *
 * @param {Object} boss - a started PgBoss instance
 * @param {Object} [opts]
 * @param {Object} [opts.pool] - pg client/pool for dropOldPartitions (defaults to db/pool)
 * @returns {Promise<void>}
 */
async function registerRetentionJob(boss, opts = {}) {
  if (!boss || typeof boss.work !== "function") {
    throw new Error("registerRetentionJob requires a started PgBoss instance");
  }
  const client = opts.pool || require("../db/pool");
  await boss.work(RETENTION_JOB_NAME, async () => {
    await dropOldPartitions(client);
  });
}

/**
 * Enqueue a one-off retention run.
 *
 * @param {Object} boss - a started PgBoss instance
 * @param {number} [retentionMonths] - override retention window
 * @returns {Promise<string|null>} job id, or null if boss missing
 */
async function enqueueRetentionJob(boss, retentionMonths) {
  if (!boss || typeof boss.send !== "function") return null;
  const months =
    retentionMonths ?? (Number(process.env.AUDIT_LOG_RETENTION_MONTHS) || 12);
  return boss.send(RETENTION_JOB_NAME, { retentionMonths: months });
}

module.exports = {
  dropOldPartitions,
  registerRetentionJob,
  enqueueRetentionJob,
  RETENTION_JOB_NAME,
};
