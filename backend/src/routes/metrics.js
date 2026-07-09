/**
 * src/routes/metrics.js
 *
 * GET /metrics — Prometheus scrape endpoint.
 *
 * Auth model: the route is protected by a configurable bearer token
 * (`METRICS_BEARER_TOKEN` from env). If the token is unset, the
 * endpoint is unauthenticated (intended for local dev only). For
 * production, the K8s ServiceMonitor scrapes this URL from inside the
 * cluster network, and the token is wired through a Secret.
 *
 * The endpoint emits Prometheus' standard text format
 * (`text/plain; version=0.0.4; charset=utf-8`) and is NOT rate-limited
 * (Prometheus scrapes are predictable; rate-limiting would create
 * flap during normal load).
 */
"use strict";

const crypto = require("crypto");
const express = require("express");
const logger = require("../logger");
const { registry } = require("../services/metrics");
const pool = require("../db/pool");
const { refreshDbPoolMetrics } = require("../services/metrics");

const router = express.Router();

function timingSafeStringEquals(a, b) {
  // Length precheck (timingSafeEqual requires equal-length buffers).
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function metricsAuth(req, res, next) {
  const expected = process.env.METRICS_BEARER_TOKEN;
  if (!expected) {
    return next(); // Dev mode: no token configured.
  }
  const auth = req.get("Authorization") || "";
  const provided = auth.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;
  if (!timingSafeStringEquals(provided || "", expected)) {
    return res.status(401).json({ error: "Invalid or missing metrics bearer token" });
  }
  return next();
}

router.get("/", metricsAuth, async (_req, res, next) => {
  try {
    // Refresh pool gauges right before the scrape so the values are
    // current as-of this scrape, not stale by up to the collection
    // interval.
    refreshDbPoolMetrics(pool);
    const body = await registry.metrics();
    res.set("Content-Type", registry.contentType);
    res.send(body);
  } catch (err) {
    logger.error({ event: "metrics_scrape_error", err: err.message }, "metrics scrape failed");
    next(err);
  }
});

module.exports = router;
