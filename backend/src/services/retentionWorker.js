"use strict";

/**
 * src/services/retentionWorker.js
 *
 * Reusable, config-driven data-retention worker.
 *
 * Design goals (matching the surrounding codebase conventions):
 *   - Reads policies from src/config/retentionPolicies.js — no policy logic
 *     hard-coded here.
 *   - Supports both "delete" and "anonymize" strategies.
 *   - Idempotent: anonymize stamps `anonymised_at` (and its WHERE clause
 *     excludes already-anonymized rows); delete uses a deterministic time
 *     window so a re-run removes nothing new.
 *   - Continues processing remaining policies if one fails; never aborts the
 *     whole batch on a single policy error.
 *   - Emits Prometheus metrics via the shared registry (no new framework).
 *   - Writes an audit entry (src/services/audit.js) per policy execution.
 *   - Structured logging via the shared pino logger.
 *   - SQL-injection-safe: table/column names come from the validated config
 *     (allow-listed identifiers); all values are bound parameters.
 *
 * pg-boss wiring: an already-started PgBoss instance is passed in via
 * `registerRetentionWorker(boss)`. We deliberately do NOT create a pg-boss
 * singleton here — callers wire it into the existing boss to avoid duplicate
 * connections (same convention as auditRetention.js). Scheduling is driven by
 * the policy `schedule.cron` using boss.schedule.
 */

const logger = require("../logger");
const { logAdminAction } = require("./audit");
const { registry } = require("./metrics");
const {
  policies,
  byName,
  validatePolicy,
} = require("../config/retentionPolicies");

const RETENTION_JOB_NAME = "data-retention";

// ── Metrics ──────────────────────────────────────────────────────────────────
// Counter of rows acted on by the retention worker, labelled by policy + strategy.
const retentionRowsCleanedTotal = new (require("prom-client").Counter)({
  name: "retention_rows_cleaned_total",
  help: "Rows acted on by the data-retention worker (deleted or anonymized), labelled by policy and strategy.",
  labelNames: ["policy", "strategy"],
  registers: [registry],
});

// Gauge recording the last successful execution timestamp (epoch ms) per policy.
const retentionLastRunSeconds = new (require("prom-client").Gauge)({
  name: "retention_last_run_timestamp_seconds",
  help: "Epoch timestamp (seconds) of the last retention run for each policy.",
  labelNames: ["policy"],
  registers: [registry],
});

// Counter of per-policy execution failures.
const retentionRunErrorsTotal = new (require("prom-client").Counter)({
  name: "retention_run_errors_total",
  help: "Count of retention policy executions that failed, labelled by policy.",
  labelNames: ["policy"],
  registers: [registry],
});

const retentionMetrics = {
  retentionRowsCleanedTotal,
  retentionLastRunSeconds,
  retentionRunErrorsTotal,
};

// In-memory record of last execution per policy (surfaced by the admin API).
const lastExecution = new Map();

function recordExecution(name, result) {
  lastExecution.set(name, {
    policy: name,
    strategy: result.strategy,
    affectedRows: result.affectedRows,
    status: result.status,
    executedAt: new Date().toISOString(),
    error: result.error || null,
  });
}

/**
 * Count pending rows for a policy (rows that WOULD be acted on by the next run).
 * Uses a SELECT COUNT(*) with the same WHERE clause the cleanup uses, binding
 * the retention value as a parameter.
 *
 * @param {Object} client - pg client/pool with .query()
 * @param {Object} policy - a validated retention policy
 * @returns {Promise<number>} pending row count
 */
async function countPending(client, policy) {
  const sql = `SELECT COUNT(*)::bigint AS pending FROM ${policy.table} WHERE ${policy.condition}`;
  const result = await client.query(sql, [policy.retentionPeriod.value]);
  return Number(result.rows[0]?.pending ?? 0);
}

/**
 * Execute a single retention policy against the database.
 *
 * @param {Object} client - pg client/pool with .query()
 * @param {Object} policy - a validated retention policy
 * @param {Object} [opts]
 * @param {string} [opts.actor] - actor recorded in the audit log
 * @returns {Promise<{ policy:string, strategy:string, affectedRows:number, status:string, error?:string }>}
 */
async function runPolicy(client, policy, opts = {}) {
  const actor = opts.actor || "retention-worker";

  try {
    validatePolicy(policy, policies.indexOf(policy));
    let affectedRows = 0;

    if (policy.strategy === "delete") {
      const sql = `DELETE FROM ${policy.table} WHERE ${policy.condition}`;
      const result = await client.query(sql, [policy.retentionPeriod.value]);
      affectedRows = result.rowCount ?? 0;
    } else if (policy.strategy === "anonymize") {
      // Build a safe SET clause from allow-listed columns: each PII column is
      // set to NULL, and the audit column is stamped with now().
      const sets = policy.anonymizeFields
        .map((col) => `${col} = NULL`)
        .concat([`${policy.anonymizedAtColumn} = NOW()`])
        .join(", ");
      const sql = `UPDATE ${policy.table} SET ${sets} WHERE ${policy.condition}`;
      const result = await client.query(sql, [policy.retentionPeriod.value]);
      affectedRows = result.rowCount ?? 0;
    } else {
      throw new Error(`Unsupported strategy: ${policy.strategy}`);
    }

    retentionRowsCleanedTotal.inc(
      { policy: policy.name, strategy: policy.strategy },
      affectedRows,
    );
    retentionLastRunSeconds.set({ policy: policy.name }, Date.now() / 1000);

    const result = {
      policy: policy.name,
      strategy: policy.strategy,
      affectedRows,
      status: "success",
    };
    recordExecution(policy.name, result);

    logger.info(
      {
        event: "retention_policy_run",
        policy: policy.name,
        strategy: policy.strategy,
        affectedRows,
      },
      `[retentionWorker] Policy "${policy.name}" ${policy.strategy}d ${affectedRows} row(s)`,
    );

    await logAdminAction({
      actor,
      action: "retention.run",
      targetType: "retention-policy",
      targetId: policy.name,
      metadata: {
        strategy: policy.strategy,
        table: policy.table,
        affectedRows,
        retentionPeriod: policy.retentionPeriod,
      },
      ipAddress: null,
    }).catch(() => {
      // audit logging must not fail the retention run
    });

    return result;
  } catch (err) {
    retentionRunErrorsTotal.inc({ policy: policy.name });
    const result = {
      policy: policy.name,
      strategy: policy.strategy,
      affectedRows: 0,
      status: "failed",
      error: err.message,
    };
    recordExecution(policy.name, result);

    logger.error(
      {
        event: "retention_policy_failed",
        policy: policy.name,
        strategy: policy.strategy,
        err: err.message,
      },
      `[retentionWorker] Policy "${policy.name}" failed: ${err.message}`,
    );

    return result;
  }
}

/**
 * Run every configured policy in sequence. A failure in one policy is recorded
 * and the loop continues with the next policy (no early abort).
 *
 * @param {Object} client - pg client/pool with .query()
 * @param {Object} [opts]
 * @param {string[]} [opts.only] - optional list of policy names to run
 * @param {string} [opts.actor] - actor for audit entries
 * @returns {Promise<Array>} per-policy results (includes failures)
 */
async function runAllPolicies(client, opts = {}) {
  const only = opts.only
    ? new Set(opts.only)
    : null;
  const toRun = only
    ? policies.filter((p) => only.has(p.name))
    : policies;

  const results = [];
  for (const policy of toRun) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runPolicy(client, policy, opts);
    results.push(res);
  }
  return results;
}

/**
 * Register a pg-boss worker + recurring schedules for each policy.
 * Pass an already-started PgBoss instance. Each policy is scheduled via
 * boss.schedule using its `schedule.cron`; the worker handler runs the single
 * matching policy so a single failed policy can't block the others.
 *
 * @param {Object} boss - a started PgBoss instance
 * @param {Object} [opts]
 * @param {Object} [opts.pool] - pg client/pool (defaults to db/pool)
 * @returns {Promise<void>}
 */
async function registerRetentionWorker(boss, opts = {}) {
  if (!boss || typeof boss.work !== "function" || typeof boss.schedule !== "function") {
    throw new Error("registerRetentionWorker requires a started PgBoss instance");
  }
  const client = opts.pool || require("../db/pool");

  await boss.work(RETENTION_JOB_NAME, async (job) => {
    const { policy } = job.data || {};
    if (policy) {
      const found = byName(policy);
      if (!found) {
        logger.warn(
          { event: "retention_unknown_policy", policy },
          `[retentionWorker] Ignoring unknown policy "${policy}"`,
        );
        return;
      }
      await runPolicy(client, found);
      return;
    }
    // No specific policy requested → run all.
    await runAllPolicies(client);
  });

  // Schedule each policy on its own cron so they run independently.
  for (const policy of policies) {
    try {
      await boss.schedule(
        RETENTION_JOB_NAME,
        policy.schedule.cron,
        { policy: policy.name },
        { tz: policy.schedule.timezone || "UTC" },
      );
    } catch (err) {
      logger.error(
        {
          event: "retention_schedule_failed",
          policy: policy.name,
          err: err.message,
        },
        `[retentionWorker] Failed to schedule policy "${policy.name}": ${err.message}`,
      );
    }
  }

  logger.info(
    { event: "retention_worker_registered", policies: policies.map((p) => p.name) },
    `[retentionWorker] Registered worker + schedules for ${policies.length} policy(ies)`,
  );
}

/**
 * Enqueue a one-off retention run (optionally for a single policy).
 *
 * @param {Object} boss - a started PgBoss instance
 * @param {Object} [opts]
 * @param {string} [opts.policy] - policy name to run; omit for all
 * @returns {Promise<string|null>} job id, or null if boss missing
 */
async function enqueueRetentionRun(boss, opts = {}) {
  if (!boss || typeof boss.send !== "function") return null;
  return boss.send(RETENTION_JOB_NAME, opts.policy ? { policy: opts.policy } : {});
}

/**
 * Status snapshot for the admin API: configured policies + pending counts +
 * last execution. `countPending` is optional (skipped when no client is given,
 * e.g. for a lightweight config view).
 *
 * @param {Object} [client] - pg client/pool (optional)
 * @returns {Promise<Array>} status entries
 */
async function getStatus(client) {
  const entries = await Promise.all(
    policies.map(async (policy) => {
      let pending = null;
      if (client) {
        try {
          // eslint-disable-next-line no-await-in-loop
          pending = await countPending(client, policy);
        } catch {
          pending = null;
        }
      }
      const last = lastExecution.get(policy.name) || null;
      return {
        name: policy.name,
        table: policy.table,
        strategy: policy.strategy,
        retentionPeriod: policy.retentionPeriod,
        schedule: policy.schedule,
        description: policy.description,
        pendingRows: pending,
        lastExecution: last,
      };
    }),
  );
  return entries;
}

module.exports = {
  RETENTION_JOB_NAME,
  runPolicy,
  runAllPolicies,
  countPending,
  registerRetentionWorker,
  enqueueRetentionRun,
  getStatus,
  byName,
  metrics: retentionMetrics,
  _lastExecution: lastExecution,
};
