#!/usr/bin/env node
/**
 * scripts/business-metrics-exporter.js
 *
 * Business-level Prometheus metrics exporter for Stellar IndigoPay (issue #1144 Part B).
 *
 * Queries Postgres for business KPIs and exposes them as Prometheus gauges.
 * Metrics are aggregate-only — no individual donor data is exposed.
 *
 * Metrics exported:
 *   indigopay_business_daily_donations_total       gauge  donations recorded today
 *   indigopay_business_daily_xlm_total             gauge  XLM donated today (stroops)
 *   indigopay_business_monthly_donations_total     gauge  donations this calendar month
 *   indigopay_business_monthly_xlm_total           gauge  XLM donated this month (stroops)
 *   indigopay_business_active_donors_7d            gauge  unique donors in last 7 days
 *   indigopay_business_active_donors_30d           gauge  unique donors in last 30 days
 *   indigopay_business_projects_total              gauge  total registered projects
 *   indigopay_business_projects_active             gauge  active (non-paused) projects
 *   indigopay_business_top_project_xlm_total       gauge{project_id}  top-5 projects by XLM raised
 *   indigopay_business_co2_offset_kg_total         gauge  total CO₂ offset kg (all time)
 *   indigopay_business_co2_offset_kg_30d           gauge  CO₂ offset kg in last 30 days
 *   indigopay_business_conversion_rate             gauge  wallet-connect → donation conversion (30d)
 *   indigopay_business_retention_rate_30d          gauge  donor retention: donors who gave in both 30d windows
 *   indigopay_business_ai_summary_cost_usd_30d     gauge  estimated AI summary cost in USD (30 days)
 *   indigopay_business_webhook_delivery_rate_24h   gauge  successful webhook delivery rate (24h)
 *   indigopay_business_recurring_donors_active     gauge  active recurring donation subscriptions
 *   indigopay_business_last_refresh_timestamp      gauge  unix epoch of last metric refresh
 *
 * Environment variables:
 *   DATABASE_URL    Postgres connection string (required).
 *   METRICS_PORT    HTTP port to expose /metrics on (default: 9092).
 *   REFRESH_INTERVAL_MS  How often to re-query Postgres (default: 60000 = 1 min).
 *   RUN_ONCE        If "true", emit metrics once to stdout then exit.
 *
 * Usage:
 *   # One-shot (CI verification)
 *   RUN_ONCE=true node scripts/business-metrics-exporter.js
 *
 *   # Long-running sidecar
 *   node scripts/business-metrics-exporter.js
 */

"use strict";

const http = require("node:http");
const { Pool } = require("pg");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DATABASE_URL = process.env.DATABASE_URL || "";
const METRICS_PORT = Number(process.env.METRICS_PORT || 9092);
const REFRESH_INTERVAL_MS = Number(process.env.REFRESH_INTERVAL_MS || 60_000);
const RUN_ONCE = process.env.RUN_ONCE === "true";
const STATEMENT_TIMEOUT_MS = 5000; // never stall the exporter > 5s per query

// ---------------------------------------------------------------------------
// Simple Prometheus registry (mirrors the structure in metrics.js)
// ---------------------------------------------------------------------------

/**
 * Escape a Prometheus label value: backslash → \\, double-quote → \", newline → \n
 * @param {*} v
 * @returns {string}
 */
function escapeLabelValue(v) {
  return String(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

class SimpleGauge {
  constructor(name, help, labelNames = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this._values = new Map();
  }

  set(labels, value) {
    const key =
      this.labelNames.length === 0
        ? "__default__"
        : this.labelNames.map((l) => labels[l] ?? "").join(",");
    this._values.set(key, { labels, value });
  }

  /** Clear all labeled series — call before re-populating top-N results. */
  reset() {
    this._values.clear();
  }

  render() {
    const lines = [
      `# HELP ${this.name} ${this.help}`,
      `# TYPE ${this.name} gauge`,
    ];
    for (const [, { labels, value }] of this._values) {
      if (this.labelNames.length === 0) {
        lines.push(`${this.name} ${value}`);
      } else {
        const lStr = this.labelNames
          .map((l) => `${l}="${escapeLabelValue(labels[l] ?? "")}"`)
          .join(",");
        lines.push(`${this.name}{${lStr}} ${value}`);
      }
    }
    return lines.join("\n");
  }
}

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

const metrics = {
  dailyDonationsTotal: new SimpleGauge(
    "indigopay_business_daily_donations_total",
    "Total number of donations recorded today (UTC)",
  ),
  dailyXlmTotal: new SimpleGauge(
    "indigopay_business_daily_xlm_total",
    "Total XLM donated today in stroops (UTC)",
  ),
  monthlyDonationsTotal: new SimpleGauge(
    "indigopay_business_monthly_donations_total",
    "Total number of donations recorded in the current calendar month",
  ),
  monthlyXlmTotal: new SimpleGauge(
    "indigopay_business_monthly_xlm_total",
    "Total XLM donated in the current calendar month in stroops",
  ),
  activeDonors7d: new SimpleGauge(
    "indigopay_business_active_donors_7d",
    "Number of unique donor addresses that donated in the last 7 days",
  ),
  activeDonors30d: new SimpleGauge(
    "indigopay_business_active_donors_30d",
    "Number of unique donor addresses that donated in the last 30 days",
  ),
  projectsTotal: new SimpleGauge(
    "indigopay_business_projects_total",
    "Total number of registered projects",
  ),
  projectsActive: new SimpleGauge(
    "indigopay_business_projects_active",
    "Number of active (non-paused, non-deactivated) projects",
  ),
  topProjectXlm: new SimpleGauge(
    "indigopay_business_top_project_xlm_total",
    "Total XLM raised (stroops) for top projects",
    ["project_id"],
  ),
  co2OffsetKgTotal: new SimpleGauge(
    "indigopay_business_co2_offset_kg_total",
    "Total estimated CO₂ offset in kilograms (all time)",
  ),
  co2OffsetKg30d: new SimpleGauge(
    "indigopay_business_co2_offset_kg_30d",
    "Estimated CO₂ offset in kilograms in the last 30 days",
  ),
  conversionRate: new SimpleGauge(
    "indigopay_business_conversion_rate",
    "Ratio of unique donors to wallet-connect events in the last 30 days (0-1)",
  ),
  retentionRate30d: new SimpleGauge(
    "indigopay_business_retention_rate_30d",
    "Donor retention rate: fraction of 30-60d donors who also donated in the last 30d (0-1)",
  ),
  aiSummaryCostUsd30d: new SimpleGauge(
    "indigopay_business_ai_summary_cost_usd_30d",
    "Estimated Anthropic AI summary cost in USD over the last 30 days",
  ),
  webhookDeliveryRate24h: new SimpleGauge(
    "indigopay_business_webhook_delivery_rate_24h",
    "Successful webhook delivery rate in the last 24 hours (0-1)",
  ),
  recurringDonorsActive: new SimpleGauge(
    "indigopay_business_recurring_donors_active",
    "Number of currently active recurring donation subscriptions",
  ),
  lastRefreshTimestamp: new SimpleGauge(
    "indigopay_business_last_refresh_timestamp",
    "Unix epoch seconds when business metrics were last refreshed from Postgres",
  ),
};

function renderAll() {
  return (
    Object.values(metrics)
      .map((m) => m.render())
      .join("\n") + "\n"
  );
}

// ---------------------------------------------------------------------------
// Database queries
// ---------------------------------------------------------------------------

let pool = null;

function getPool() {
  if (!pool) {
    if (!DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 2,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // statement_timeout is applied at connection level so every query
      // is bounded without needing SET LOCAL inside a transaction.
      statement_timeout: STATEMENT_TIMEOUT_MS,
    });
    pool.on("error", (err) => {
      console.error("[business-metrics] Pool error:", err.message);
    });
  }
  return pool;
}

/**
 * Run a bounded query using the pool directly. statement_timeout is
 * configured on the Pool constructor so it applies to every connection.
 * @param {string} sql
 * @param {Array} [params]
 * @returns {Promise<import('pg').QueryResult>}
 */
async function runQuery(sql, params = []) {
  return getPool().query(sql, params);
}

/**
 * Safely run a query and return its rows. On error, log and return [].
 */
async function safeQuery(name, sql, params = []) {
  try {
    const result = await runQuery(sql, params);
    return result.rows;
  } catch (err) {
    console.error(`[business-metrics] Query "${name}" failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Metric refresh
// ---------------------------------------------------------------------------

async function refreshMetrics() {
  const tasks = [];

  // ── Daily donation volume ────────────────────────────────────────────
  tasks.push(
    safeQuery(
      "daily-volume",
      `SELECT
         COUNT(*)::int                        AS count,
         COALESCE(SUM(amount_stroops), 0)::text AS total_xlm
       FROM donations
       WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC')`,
    ).then(([row]) => {
      if (row) {
        metrics.dailyDonationsTotal.set({}, Number(row.count));
        metrics.dailyXlmTotal.set({}, Number(row.total_xlm));
      }
    }),
  );

  // ── Monthly donation volume ──────────────────────────────────────────
  tasks.push(
    safeQuery(
      "monthly-volume",
      `SELECT
         COUNT(*)::int                        AS count,
         COALESCE(SUM(amount_stroops), 0)::text AS total_xlm
       FROM donations
       WHERE created_at >= date_trunc('month', NOW() AT TIME ZONE 'UTC')`,
    ).then(([row]) => {
      if (row) {
        metrics.monthlyDonationsTotal.set({}, Number(row.count));
        metrics.monthlyXlmTotal.set({}, Number(row.total_xlm));
      }
    }),
  );

  // ── Active donors 7d / 30d ───────────────────────────────────────────
  tasks.push(
    safeQuery(
      "active-donors",
      `SELECT
         COUNT(DISTINCT CASE WHEN created_at >= NOW() - INTERVAL '7 days'  THEN donor_address END)::int AS donors_7d,
         COUNT(DISTINCT CASE WHEN created_at >= NOW() - INTERVAL '30 days' THEN donor_address END)::int AS donors_30d
       FROM donations`,
    ).then(([row]) => {
      if (row) {
        metrics.activeDonors7d.set({}, Number(row.donors_7d));
        metrics.activeDonors30d.set({}, Number(row.donors_30d));
      }
    }),
  );

  // ── Projects total / active ──────────────────────────────────────────
  tasks.push(
    safeQuery(
      "projects-count",
      `SELECT
         COUNT(*)::int                                                                    AS total,
         COUNT(*) FILTER (WHERE status = 'active' OR status IS NULL)::int                AS active
       FROM projects`,
    ).then(([row]) => {
      if (row) {
        metrics.projectsTotal.set({}, Number(row.total));
        metrics.projectsActive.set({}, Number(row.active));
      }
    }),
  );

  // ── Top 5 projects by XLM raised ────────────────────────────────────
  tasks.push(
    safeQuery(
      "top-projects",
      `SELECT project_id, COALESCE(SUM(amount_stroops), 0)::text AS total_xlm
       FROM donations
       GROUP BY project_id
       ORDER BY SUM(amount_stroops) DESC NULLS LAST
       LIMIT 5`,
    ).then((rows) => {
      metrics.topProjectXlm.reset();
      for (const row of rows) {
        metrics.topProjectXlm.set({ project_id: row.project_id }, Number(row.total_xlm));
      }
    }),
  );

  // ── CO₂ offset (uses co2_per_xlm from projects table) ───────────────
  tasks.push(
    safeQuery(
      "co2-offset",
      `SELECT
         COALESCE(SUM(d.amount_stroops::numeric * p.co2_per_xlm::numeric / 1e11), 0) AS co2_total,
         COALESCE(SUM(CASE WHEN d.created_at >= NOW() - INTERVAL '30 days'
                          THEN d.amount_stroops::numeric * p.co2_per_xlm::numeric / 1e11
                          ELSE 0 END), 0) AS co2_30d
       FROM donations d
       JOIN projects p ON p.project_id = d.project_id`,
    ).then(([row]) => {
      if (row) {
        metrics.co2OffsetKgTotal.set({}, Number(row.co2_total));
        metrics.co2OffsetKg30d.set({}, Number(row.co2_30d));
      }
    }),
  );

  // ── Donor retention rate (30d cohort) ───────────────────────────────
  // Retention = donors who gave 30-60 days ago AND also gave in the last 30 days
  tasks.push(
    safeQuery(
      "retention",
      `WITH cohort_60_30 AS (
         SELECT DISTINCT donor_address
         FROM donations
         WHERE created_at >= NOW() - INTERVAL '60 days'
           AND created_at <  NOW() - INTERVAL '30 days'
       ),
       cohort_30 AS (
         SELECT DISTINCT donor_address
         FROM donations
         WHERE created_at >= NOW() - INTERVAL '30 days'
       )
       SELECT
         COUNT(c60.donor_address)::int                                      AS cohort_size,
         COUNT(c30.donor_address)::int                                      AS retained,
         CASE WHEN COUNT(c60.donor_address) = 0 THEN 0
              ELSE COUNT(c30.donor_address)::numeric / COUNT(c60.donor_address)
         END AS retention_rate
       FROM cohort_60_30 c60
       LEFT JOIN cohort_30 c30 ON c60.donor_address = c30.donor_address`,
    ).then(([row]) => {
      if (row) {
        metrics.retentionRate30d.set({}, Number(row.retention_rate));
      }
    }),
  );

  // ── AI summary cost estimate (30d) ──────────────────────────────────
  // Rough estimate: $3 / 1M input tokens + $15 / 1M output tokens (Claude pricing)
  // If ai_summaries table doesn't exist, returns 0 gracefully.
  tasks.push(
    safeQuery(
      "ai-cost",
      `SELECT
         COALESCE(
           SUM(input_tokens) * 3.0 / 1e6 + SUM(output_tokens) * 15.0 / 1e6,
           0
         ) AS cost_usd
       FROM ai_summaries
       WHERE created_at >= NOW() - INTERVAL '30 days'`,
    ).then(([row]) => {
      metrics.aiSummaryCostUsd30d.set({}, row ? Number(row.cost_usd) : 0);
    }),
  );

  // ── Webhook delivery rate (24h) ──────────────────────────────────────
  tasks.push(
    safeQuery(
      "webhook-delivery",
      `SELECT
         COUNT(*)::int                                           AS total,
         COUNT(*) FILTER (WHERE state = 'completed')::int       AS delivered
       FROM webhook_deliveries
       WHERE created_on >= NOW() - INTERVAL '24 hours'`,
    ).then(([row]) => {
      if (row && Number(row.total) > 0) {
        metrics.webhookDeliveryRate24h.set({}, Number(row.delivered) / Number(row.total));
      } else {
        metrics.webhookDeliveryRate24h.set({}, 1); // no deliveries = trivially 100%
      }
    }),
  );

  // ── Active recurring donations ───────────────────────────────────────
  tasks.push(
    safeQuery(
      "recurring",
      `SELECT COUNT(*)::int AS active FROM recurring_donations WHERE status = 'active'`,
    ).then(([row]) => {
      metrics.recurringDonorsActive.set({}, row ? Number(row.active) : 0);
    }),
  );

  // ── Wallet-connect → donation conversion rate (30d) ──────────────────
  // Conversion = distinct donors / distinct wallet_connects in last 30 days
  // Falls back to 0 if wallet_connect_events table doesn't exist.
  tasks.push(
    safeQuery(
      "conversion",
      `SELECT
         (SELECT COUNT(DISTINCT donor_address) FROM donations
          WHERE created_at >= NOW() - INTERVAL '30 days')::numeric AS donors,
         (SELECT COUNT(DISTINCT address)       FROM wallet_connect_events
          WHERE created_at >= NOW() - INTERVAL '30 days')::numeric AS connects`,
    ).then(([row]) => {
      if (row && Number(row.connects) > 0) {
        const rate = Math.min(Number(row.donors) / Number(row.connects), 1);
        metrics.conversionRate.set({}, rate);
      } else if (row && Number(row.connects) === 0 && Number(row.donors) > 0) {
        metrics.conversionRate.set({}, 1);
      } else {
        metrics.conversionRate.set({}, 0);
      }
    }),
  );

  await Promise.allSettled(tasks);

  metrics.lastRefreshTimestamp.set({}, Math.floor(Date.now() / 1000));

  console.log(
    `[business-metrics] Refreshed at ${new Date().toISOString()}`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (!DATABASE_URL) {
    console.error("[business-metrics] DATABASE_URL is not set. Exiting.");
    process.exit(1);
  }

  // Initial refresh
  await refreshMetrics();

  if (RUN_ONCE) {
    process.stdout.write(renderAll());
    if (pool) await pool.end();
    return;
  }

  // HTTP server for /metrics
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      const body = renderAll();
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(body);
    } else if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(METRICS_PORT, () => {
    console.log(
      `[business-metrics] Exporter listening on :${METRICS_PORT}/metrics`,
    );
  });

  // Periodic refresh
  setInterval(refreshMetrics, REFRESH_INTERVAL_MS);

  // Graceful shutdown
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, async () => {
      console.log(`[business-metrics] Received ${sig}, shutting down…`);
      server.close();
      if (pool) await pool.end();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[business-metrics] Fatal:", err);
  process.exit(1);
});
