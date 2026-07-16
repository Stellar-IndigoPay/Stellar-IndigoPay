/**
 * src/services/metrics.js
 *
 * Centralised Prometheus metrics for the Stellar IndigoPay backend.
 *
 * Exports a single shared `Registry` plus the conventional metric handles
 * used across the app. We deliberately use ONE shared registry (not one
 * per subsystem) so that the `/metrics` endpoint can emit everything in a
 * single scrape. Cardinality is controlled by:
 *   - route normalisation (`:id` patterns collapsed before labelling)
 *   - status-code bucketing (status is taken raw — there are only ~60
 *     distinct status codes we ever emit, so this is safe)
 *   - method allow-list (only GET / POST / PATCH / PUT / DELETE)
 */
"use strict";

const client = require("prom-client");
const logger = require("../logger");

const registry = new client.Registry();

// Standard resource labels so Prometheus can join to kube-state-metrics.
registry.setDefaultLabels({
  service: "stellar-indigopay-api",
  env: process.env.NODE_ENV || "development",
});

// Process + Node.js runtime metrics (heap, GC, event loop lag, fd count, …).
// 5s collection interval keeps the `/metrics` scrape small while still
// catching event-loop stalls quickly.
client.collectDefaultMetrics({
  register: registry,
  prefix: "nodejs_",
  eventLoopMonitoringPrecision: 5,
});

const httpRequestsTotal = new client.Counter({
  name: "http_requests_total",
  help: "Count of HTTP requests served, labelled by method, route, and status code.",
  labelNames: ["method", "route", "status_code"],
  registers: [registry],
});

const httpRequestDurationSeconds = new client.Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds, labelled by method, route, and status code.",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const httpRequestsInFlight = new client.Gauge({
  name: "http_requests_in_flight",
  help: "Number of HTTP requests currently being served. Labelled by method only; the route is captured by the counter and histogram on response.",
  labelNames: ["method"],
  registers: [registry],
});

const dbPoolTotalCount = new client.Gauge({
  name: "db_pool_total_count",
  help: "Total number of clients in the Postgres connection pool.",
  registers: [registry],
});

const dbPoolIdleCount = new client.Gauge({
  name: "db_pool_idle_count",
  help: "Number of idle clients in the Postgres connection pool.",
  registers: [registry],
});

const dbPoolWaitingCount = new client.Gauge({
  name: "db_pool_waiting_count",
  help: "Number of queued requests waiting for a Postgres connection.",
  registers: [registry],
});

const dbPoolUtilizationRatio = new client.Gauge({
  name: "db_pool_utilization_ratio",
  help: "Ratio of total connections to max connections in the Postgres pool.",
  registers: [registry],
});

const dbSlowQueriesTotal = new client.Counter({
  name: "db_slow_queries_total",
  help: "Total number of slow database queries, labelled by operation.",
  labelNames: ["operation"],
  registers: [registry],
});

const dbConnectionErrorsTotal = new client.Counter({
  name: "db_connection_errors_total",
  help: "Total number of Postgres connection errors.",
  registers: [registry],
});

const dbQueryDurationSeconds = new client.Histogram({
  name: "db_query_duration_seconds",
  help: "Postgres query duration in seconds, labelled by operation and success.",
  labelNames: ["operation", "success"],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry],
});

const cacheOperationsTotal = new client.Counter({
  name: "cache_operations_total",
  help: "Cache operations, labelled by cache (memory|redis), op (get|set|delete), and result (hit|miss|error|ok).",
  labelNames: ["cache", "op", "result"],
  registers: [registry],
});

const queueJobsTotal = new client.Counter({
  name: "queue_jobs_total",
  help: "pg-boss jobs, labelled by queue and outcome (completed|failed|started).",
  labelNames: ["queue", "outcome"],
  registers: [registry],
});

const indexerLagSeconds = new client.Gauge({
  name: "indexer_lag_seconds",
  help: "Seconds between the latest on-chain ledger seen by the indexer and now.",
  registers: [registry],
});

const indexerRunning = new client.Gauge({
  name: "indexer_running",
  help: "1 if the indexer polling loop is running, 0 otherwise.",
  registers: [registry],
});



const readinessCheckFailedTotal = new client.Counter({
  name: "readiness_check_failed_total",
  help: "Count of /api/readyz responses with HTTP 503 (readiness probe failed).",
  labelNames: ["reason"],
  registers: [registry],
});

const webhookDeliveriesTotal = new client.Counter({
  name: "webhook_deliveries_total",
  help: "Webhook delivery outcomes, labelled by outcome (delivered|retry|dlq|skipped).",
  labelNames: ["outcome"],
  registers: [registry],
});

const webhookAttemptsTotal = new client.Counter({
  name: "webhook_attempts_total",
  help: "Number of webhook HTTP attempts, labelled by event_type.",
  labelNames: ["event_type"],
  registers: [registry],
});

const webhookAttemptDurationSeconds = new client.Histogram({
  name: "webhook_attempt_duration_seconds",
  help: "Duration of webhook HTTP attempts in seconds, labelled by outcome (success|failure).",
  labelNames: ["outcome"],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

const aiSummaryTokensTotal = new client.Counter({
  name: "ai_summary_tokens_total",
  help: "Anthropic tokens consumed by the AI summary feature, labelled by model and direction (input|output|cache_read|cache_write).",
  labelNames: ["model", "direction"],
  registers: [registry],
});

const aiSummaryCostUsdTotal = new client.Counter({
  name: "ai_summary_cost_usd_total",
  help: "Estimated USD cost for AI summary generations, labelled by model. Computed from the per-model token pricing sheet in lib/anthropicPricing.js.",
  labelNames: ["model"],
  registers: [registry],
});

const aiSummaryLatencySeconds = new client.Histogram({
  name: "ai_summary_latency_seconds",
  help: "End-to-end latency of generateProjectSummary in seconds, labelled by model and outcome (success|error).",
  labelNames: ["model", "outcome"],
  buckets: [0.25, 0.5, 1, 2, 4, 8, 16, 32, 64],
  registers: [registry],
});

const aiSummaryOutcomesTotal = new client.Counter({
  name: "ai_summary_outcomes_total",
  help: "AI summary generation outcomes, labelled by outcome (success|error) and reason (api_key|empty_response|provider_error|rate_limit|...).",
  labelNames: ["outcome", "reason"],
  registers: [registry],
});

const queueDepth = new client.Gauge({
  name: "queue_depth",
  help: "Total number of jobs waiting or active in the queue.",
  labelNames: ["queue"],
  registers: [registry],
});

const queueActive = new client.Gauge({
  name: "queue_active",
  help: "Number of active jobs currently running in the queue.",
  labelNames: ["queue"],
  registers: [registry],
});

const queueWaiting = new client.Gauge({
  name: "queue_waiting",
  help: "Number of waiting jobs in the queue.",
  labelNames: ["queue"],
  registers: [registry],
});

const queueFailed = new client.Gauge({
  name: "queue_failed",
  help: "Number of failed jobs in the queue.",
  labelNames: ["queue"],
  registers: [registry],
});

const queueCompleted = new client.Gauge({
  name: "queue_completed",
  help: "Number of completed jobs in the queue.",
  labelNames: ["queue"],
  registers: [registry],
});

const queueLatency = new client.Gauge({
  name: "queue_latency",
  help: "Average processing latency of completed jobs in seconds.",
  labelNames: ["queue"],
  registers: [registry],
});

/**
 * Normalise an Express req.route.path / req.path to a low-cardinality
 * route label. We fall back to the literal path when no route is
 * matched (so 404s show their actual URL) but for 4xx/5xx responses we
 * additionally cap to the first 2 path segments to avoid a path with a
 * random ID exploding the label set.
 */
function normaliseRoute(req) {
  if (req.route && req.route.path) {
    const base = req.baseUrl || "";
    return `${base}${req.route.path}` || "/";
  }
  if (req.path) {
    const segs = req.path.split("/").filter(Boolean);
    if (segs.length <= 2) return req.path;
    return `/${segs.slice(0, 2).join("/")}/:rest`;
  }
  return "unknown";
}

/**
 * Update the DB-pool gauges from the live `pg.Pool`. Cheap to call —
 * node_pg exposes `totalCount` / `idleCount` / `waitingCount` directly.
 */
function refreshDbPoolMetrics(pool) {
  if (!pool) return;
  try {
    const totalCount = pool.totalCount ?? 0;
    const idleCount = pool.idleCount ?? 0;
    const waitingCount = pool.waitingCount ?? 0;
    const max = pool.max || 1;

    dbPoolTotalCount.set(totalCount);
    dbPoolIdleCount.set(idleCount);
    dbPoolWaitingCount.set(waitingCount);

    const utilizationRatio = totalCount / max;
    dbPoolUtilizationRatio.set(utilizationRatio);

    if (waitingCount > 0) {
      logger.warn(
        {
          event: "db_pool_contention",
          waitingCount,
          totalCount,
          idleCount,
          max,
        },
        `DB pool contention: ${waitingCount} queries waiting`,
      );
    }

    if (waitingCount > 5) {
      logger.error(
        {
          event: "db_pool_high_contention",
          waitingCount,
          totalCount,
          idleCount,
          max,
        },
        `DB pool high contention: ${waitingCount} queries waiting`,
      );
      readinessCheckFailedTotal.inc({ reason: "db_pool_contention" });
    }

    if (utilizationRatio >= 0.9) {
      logger.warn(
        {
          event: "db_pool_high_utilization",
          utilizationRatio,
          totalCount,
          max,
        },
        `DB pool utilization at ${(utilizationRatio * 100).toFixed(1)}%`,
      );
    }
  } catch {
    // Pool may be in a transitional state; swallow.
  }
}

const { getQueueMetrics } = require("./queueMetrics");

async function refreshQueueMetrics() {
  try {
    const metricsList = await getQueueMetrics();
    for (const q of metricsList) {
      queueDepth.set({ queue: q.queue }, q.depth);
      queueActive.set({ queue: q.queue }, q.active);
      queueWaiting.set({ queue: q.queue }, q.waiting);
      queueFailed.set({ queue: q.queue }, q.failed);
      queueCompleted.set({ queue: q.queue }, q.completed);
      queueLatency.set({ queue: q.queue }, q.latency);
    }
  } catch (err) {
    // Suppress error so scrape doesn't fail on transient issues
  }
}

module.exports = {
  registry,
  normaliseRoute,
  refreshDbPoolMetrics,
  refreshQueueMetrics,
  metrics: {
    httpRequestsTotal,
    httpRequestDurationSeconds,
    httpRequestsInFlight,
    dbPoolTotalCount,
    dbPoolIdleCount,
    dbPoolWaitingCount,
    dbPoolUtilizationRatio,
    dbSlowQueriesTotal,
    dbConnectionErrorsTotal,
    dbQueryDurationSeconds,
    cacheOperationsTotal,
    queueJobsTotal,
    indexerLagSeconds,
    indexerRunning,
    readinessCheckFailedTotal,
    webhookDeliveriesTotal,
    webhookAttemptsTotal,
    webhookAttemptDurationSeconds,
    aiSummaryTokensTotal,
    aiSummaryCostUsdTotal,
    aiSummaryLatencySeconds,
    aiSummaryOutcomesTotal,
    queueDepth,
    queueActive,
    queueWaiting,
    queueFailed,
    queueCompleted,
    queueLatency,
  },
};
