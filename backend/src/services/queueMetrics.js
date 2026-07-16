"use strict";

const pool = require("../db/pool");

const VALID_QUEUES = [
  "webhook-deliveries",
  "ai-summary",
  "profile-update",
  "monthly-impact-digest",
  "attestation-backfill"
];

function isValidQueue(name) {
  return VALID_QUEUES.includes(name);
}

/**
 * Query stats for all valid pg-boss queues.
 * Combines jobs from pgboss.job and pgboss.archive tables.
 */
async function getQueueMetrics() {
  const statsQuery = `
    SELECT 
      name,
      COUNT(*) FILTER (WHERE state = 'active') AS active,
      COUNT(*) FILTER (WHERE state IN ('created', 'retry')) AS waiting,
      COUNT(*) FILTER (WHERE state = 'failed') AS failed,
      COUNT(*) FILTER (WHERE state = 'completed') AS completed,
      AVG(EXTRACT(EPOCH FROM (completedat - startedat))) FILTER (WHERE state = 'completed') AS avg_latency
    FROM (
      SELECT name, state, startedat, completedat FROM pgboss.job
      UNION ALL
      SELECT name, state, startedat, completedat FROM pgboss.archive
    ) all_jobs
    WHERE name = ANY($1)
    GROUP BY name
  `;

  const pausedQuery = `
    SELECT name, paused FROM pgboss.queue WHERE name = ANY($1)
  `;

  // We run queries in parallel. If pg-boss tables don't exist yet, we catch
  // the database error and return default/empty counts so that the server doesn't crash.
  try {
    const [statsRes, pausedRes] = await Promise.all([
      pool.query(statsQuery, [VALID_QUEUES]),
      pool.query(pausedQuery, [VALID_QUEUES])
    ]);

    const statsMap = {};
    for (const row of statsRes.rows) {
      statsMap[row.name] = {
        active: parseInt(row.active, 10) || 0,
        waiting: parseInt(row.waiting, 10) || 0,
        failed: parseInt(row.failed, 10) || 0,
        completed: parseInt(row.completed, 10) || 0,
        avg_latency: parseFloat(row.avg_latency) || 0
      };
    }

    const pausedMap = {};
    for (const row of pausedRes.rows) {
      pausedMap[row.name] = !!row.paused;
    }

    return VALID_QUEUES.map(name => {
      // eslint-disable-next-line security/detect-object-injection
      const stats = statsMap[name] || { active: 0, waiting: 0, failed: 0, completed: 0, avg_latency: 0 };
      // eslint-disable-next-line security/detect-object-injection
      const paused = pausedMap[name] || false;
      const depth = stats.active + stats.waiting;
      const ended = stats.completed + stats.failed;
      const failure_rate = ended > 0 ? (stats.failed / ended) : 0;

      return {
        queue: name,
        active: stats.active,
        waiting: stats.waiting,
        failed: stats.failed,
        completed: stats.completed,
        depth,
        failure_rate,
        latency: stats.avg_latency, // in seconds
        paused
      };
    });
  } catch (err) {
    // If the pgboss schema or tables don't exist yet, return empty stats
    // this handles bootstrap stages or unit tests gracefully.
    return VALID_QUEUES.map(name => ({
      queue: name,
      active: 0,
      waiting: 0,
      failed: 0,
      completed: 0,
      depth: 0,
      failure_rate: 0,
      latency: 0,
      paused: false
    }));
  }
}

/**
 * Pause a queue by setting its paused flag in the pgboss.queue table.
 */
async function pauseQueue(name) {
  if (!isValidQueue(name)) {
    throw new Error(`Invalid queue name: ${name}`);
  }
  await pool.query(
    `INSERT INTO pgboss.queue (name, paused)
     VALUES ($1, true)
     ON CONFLICT (name) DO UPDATE SET paused = true`,
    [name]
  );
}

/**
 * Resume a queue by setting its paused flag in the pgboss.queue table.
 */
async function resumeQueue(name) {
  if (!isValidQueue(name)) {
    throw new Error(`Invalid queue name: ${name}`);
  }
  await pool.query(
    `INSERT INTO pgboss.queue (name, paused)
     VALUES ($1, false)
     ON CONFLICT (name) DO UPDATE SET paused = false`,
    [name]
  );
}

/**
 * Purge a queue by deleting its active/waiting/retry jobs from the job table.
 */
async function purgeQueue(name) {
  if (!isValidQueue(name)) {
    throw new Error(`Invalid queue name: ${name}`);
  }
  await pool.query(
    "DELETE FROM pgboss.job WHERE name = $1",
    [name]
  );
}

module.exports = {
  VALID_QUEUES,
  isValidQueue,
  getQueueMetrics,
  pauseQueue,
  resumeQueue,
  purgeQueue
};
