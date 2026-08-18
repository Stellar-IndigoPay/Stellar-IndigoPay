/**
 * src/routes/admin/metrics.js
 *
 * GET /api/admin/metrics/slo — Proxy Prometheus SLO metrics for the
 * transparency dashboard. Returns error ratios and remaining error budgets
 * for the platform's two core SLOs:
 *   - donations: 99.5% success rate (0.5% error budget)
 *   - projects:  99.9% success rate (0.1% error budget)
 *
 * Requires admin authentication. The endpoint queries Prometheus directly
 * for the pre-computed SLO recording rules defined in the monitoring stack.
 *
 * Prometheus recording rules expected:
 *   slo:donations:error_ratio   — 5-minute sliding error ratio for donations
 *   slo:projects:error_ratio    — 5-minute sliding error ratio for project listing
 *
 * Mounted at /api/admin/metrics/slo (see routes/admin.js).
 */
"use strict";

const express = require("express");
const router = express.Router();
const { adminRequired } = require("../../middleware/auth");

const PROMETHEUS_URL =
  process.env.PROMETHEUS_URL || "http://prometheus:9090";

const SLO_TARGETS = {
  donations: { errorBudget: 0.005 }, // 99.5%
  projects: { errorBudget: 0.001 },  // 99.9%
};

const PROMETHEUS_QUERIES = {
  donations: "slo:donations:error_ratio",
  projects: "slo:projects:error_ratio",
};

/**
 * Compute remaining error budget as a percentage.
 * A negative value means the error budget has been fully exhausted.
 * Clamped to [-100, 100] for sensible UI display.
 */
function computeBudgetRemaining(errorRatio, budget) {
  const raw = ((budget - errorRatio) / budget) * 100;
  return Math.max(-100, Math.min(100, Math.round(raw * 100) / 100));
}

/**
 * Parse the Prometheus instant-query response for a single vector result.
 * Returns 0 when the metric has no data yet (new deployment).
 */
function parsePrometheusValue(responseBody) {
  try {
    const results = responseBody?.data?.result;
    if (!results || results.length === 0) return 0;
    return parseFloat(results[0].value[1]) || 0;
  } catch {
    return 0;
  }
}

/**
 * GET /api/admin/metrics/slo
 *
 * Queries Prometheus for both SLO error ratios and returns a structured
 * response with the raw ratio and remaining budget percentage.
 */
router.get("/slo", adminRequired, async (req, res, next) => {
  try {
    const queryPromises = Object.entries(PROMETHEUS_QUERIES).map(
      async ([key, query]) => {
        try {
          const response = await fetch(
            `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`,
            {
              signal: AbortSignal.timeout(5000),
              headers: { Accept: "application/json" },
            },
          );

          if (!response.ok) {
            throw new Error(`Prometheus responded with ${response.status}`);
          }

          const body = await response.json();
          const errorRatio = parsePrometheusValue(body);
          const target = SLO_TARGETS[key];
          const budgetRemaining = computeBudgetRemaining(
            errorRatio,
            target.errorBudget,
          );

          return [key, { errorRatio, errorBudgetRemaining: budgetRemaining }];
        } catch (err) {
          // Prometheus may be unreachable in development; return zeroed data
          // so the dashboard doesn't break — the frontend can show a warning.
          return [
            key,
            {
              errorRatio: 0,
              errorBudgetRemaining: 100,
              error: err.message || "Prometheus query failed",
            },
          ];
        }
      },
    );

    const entries = await Promise.all(queryPromises);
    const data = Object.fromEntries(entries);

    res.json({ success: true, data });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
