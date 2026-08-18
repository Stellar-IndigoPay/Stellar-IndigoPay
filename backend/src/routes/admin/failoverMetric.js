/**
 * src/routes/admin/failoverMetric.js
 *
 * POST /api/admin/failover-metric
 *
 * Allows the automated Postgres failover Job to increment the
 * `indigopay_postgres_failover_total` Prometheus counter at each
 * stage of the failover process.
 *
 * Authenticated via a shared bearer token (FAILOVER_METRICS_TOKEN)
 * mounted from the cluster Secret. This endpoint is intentionally
 * lightweight — no DB queries, no audit logging — so it works
 * during a failover when the DB may be transitioning.
 *
 * Mounted at /api/admin/failover-metric (see routes/admin.js).
 */
"use strict";

const express = require("express");
const router = express.Router();
const logger = require("../../logger");
const { sendAppError } = require("../../errors");

const VALID_OUTCOMES = new Set(["initiated", "succeeded", "failed"]);

/**
 * POST /api/admin/failover-metric
 *
 * Body: { "outcome": "initiated" | "succeeded" | "failed" }
 * Auth: Bearer <FAILOVER_METRICS_TOKEN>
 *
 * Increments indigopay_postgres_failover_total{outcome=...} and
 * returns 200 on success.
 */
router.post("/", (req, res) => {
  try {
    // Authenticate via a shared bearer token.
    const expectedToken = process.env.FAILOVER_METRICS_TOKEN;
    if (expectedToken) {
      const authHeader = req.headers.authorization || "";
      const providedToken = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : "";
      if (providedToken !== expectedToken) {
        return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid token" });
      }
    }

    const { outcome } = req.body || {};
    if (!outcome || !VALID_OUTCOMES.has(outcome)) {
      return sendAppError(res, "VALIDATION_ERROR", {
        field: "outcome",
        detail: `outcome must be one of: ${[...VALID_OUTCOMES].join(", ")}`,
      });
    }

    // Increment the Prometheus counter if available.
    try {
      const { metrics } = require("../../services/metrics");
      if (metrics.postgresFailoverTotal) {
        metrics.postgresFailoverTotal.inc({ outcome });
      }
    } catch {
      // prom-client may not be loaded in test environments; non-fatal.
    }

    logger.info(
      { event: "failover_metric", outcome },
      `Postgres failover metric: outcome=${outcome}`,
    );

    res.json({ success: true, outcome });
  } catch (e) {
    logger.error(
      { event: "failover_metric_error", err: e.message },
      "Failed to record failover metric",
    );
    return sendAppError(res, "INTERNAL_ERROR", {
      detail: "Failed to record metric",
    });
  }
});

module.exports = router;
