/**
 * src/routes/health.js
 *
 * Liveness probe. K8s/load-balancers use this to decide whether to
 * RESTART the process. Therefore it MUST be cheap and MUST NOT depend
 * on downstream services (DB, Redis, Horizon) — a temporary DB outage
 * should not cause the orchestrator to kill the pod.
 *
 * The only failure modes that return 503 are:
 *   - the process is in the middle of graceful shutdown (so the
 *     orchestrator should stop sending new traffic), or
 *   - the Node process has been up for less than 5 seconds (boot
 *     grace window — avoids restart loops on slow first paint).
 */
"use strict";

const express = require("express");
const router = express.Router();
const { isShuttingDown } = require("../services/lifecycle");

const BOOT_GRACE_SECONDS = 5;

router.get("/", (_req, res) => {
  if (isShuttingDown()) {
    return res.status(503).json({
      status: "draining",
      service: "stellar-indigopay-api",
      timestamp: new Date().toISOString(),
    });
  }

  const uptimeSeconds = process.uptime();
  if (uptimeSeconds < BOOT_GRACE_SECONDS) {
    return res.status(503).json({
      status: "starting",
      service: "stellar-indigopay-api",
      uptimeSeconds,
      timestamp: new Date().toISOString(),
    });
  }

  // Attach indexer status from the service (best-effort — cheap, local).
  let indexerStatus = null;
  try {
    const indexerService = require("../services/indexerService");
    indexerStatus = indexerService.getStatus();
  } catch {
    // Indexer may not be loaded yet; skip.
  }

  return res.status(200).json({
    status: "ok",
    service: "stellar-indigopay-api",
    network: process.env.STELLAR_NETWORK || "testnet",
    uptimeSeconds,
    indexer: indexerStatus,
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
