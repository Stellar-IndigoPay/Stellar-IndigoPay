/**
 * src/routes/readiness.js
 *
 * Readiness probe. K8s uses this to decide whether to ROUTE TRAFFIC
 * to the pod. It checks every downstream the request path actually
 * touches: Postgres, Redis (optional), the Horizon RPC (best-effort
 * 4s timeout), and the Sentry transport (Drain in progress?).
 *
 * Returns 503 as soon as ANY required subsystem is unhealthy. The
 * response body lists every check, including the optional ones, so an
 * operator can read it directly without a separate debug page.
 *
 * Note: this endpoint is intentionally NOT cached and does NOT emit a
 * metric on every check (would double-count scrape traffic).
 */
"use strict";

const express = require("express");
const router = express.Router();
const logger = require("../logger");
const pool = require("../db/pool");
const { isShuttingDown } = require("../services/lifecycle");
const metrics = require("../services/metrics");
const { withRetry, rpcServer } = require("../services/stellar");

const HORIZON_URL =
  process.env.NEXT_PUBLIC_HORIZON_URL ||
  process.env.HORIZON_URL ||
  "https://horizon-testnet.stellar.org";

// Per-subsystem check timeout. The three values are coupled:
//   DB_POOL_CONNECT_TIMEOUT + DB_STATEMENT_TIMEOUT_MS <= CHECK_TIMEOUT_MS
// so a slow DB can never block /api/readyz past its deadline. Tune all
// three together; default 4000ms.
const CHECK_TIMEOUT_MS = Number(process.env.READINESS_CHECK_TIMEOUT_MS || 4000);
const MAX_REPLICA_LAG_MS = Number(process.env.MAX_REPLICA_LAG_MS || 5000);

function withTimeout(promise, ms, label) {
  // The race pattern here does NOT cancel the underlying work — for
  // pg.Pool#query (no AbortSignal support) a slow query will continue
  // to hold a pool connection until the statement completes. We mitigate
  // this by setting a `statement_timeout` on the pool itself; this
  // helper then only needs to race the resolution so a stuck query
  // doesn't block /api/readyz past the 4s window.
  return new Promise((resolve) => {
    const t = setTimeout(
      () => resolve({ ok: false, reason: `${label} timeout` }),
      ms,
    );
    promise
      .then((value) => {
        clearTimeout(t);
        resolve({ ok: true, value });
      })
      .catch((err) => {
        clearTimeout(t);
        // Log unexpected errors so silent failures are visible — a
        // bare {ok:false} would otherwise hide e.g. a permission error.
        logger.warn(
          {
            event: "readiness_subsystem_error",
            subsystem: label,
            err: err.message,
          },
          label,
        );
        resolve({ ok: false, reason: err.message });
      });
  });
}

router.get("/", async (_req, res) => {
  if (isShuttingDown()) {
    return res.status(503).json({
      status: "draining",
      timestamp: new Date().toISOString(),
      checks: {},
    });
  }

  const checks = {
    db: { status: "unknown" },
    pool: { status: "unknown" },
    readReplicaLag: { status: "skipped" },
    redis: { status: "skipped" },
    horizon: { status: "unknown" },
    soroban_rpc: { status: "unknown" },
    indexer: { status: "unknown" },
  };

  // Postgres
  const db = await withTimeout(
    pool.getWriter().query("SELECT 1"),
    CHECK_TIMEOUT_MS,
    "db",
  );
  checks.db = db.ok
    ? { status: "ok" }
    : { status: "unreachable", reason: db.reason };

  // Pool degradation (high queue depth)
  const writerPool = pool._writerPool;
  const waitingCount = writerPool.waitingCount || 0;
  const max = writerPool.max || 1;
  if (waitingCount > max * 0.5) {
    checks.pool = {
      status: "degraded",
      reason: "db_pool_degraded",
      waitingCount,
      max,
    };
  } else {
    checks.pool = { status: "ok", waitingCount, max };
  }

  // Read replica lag. A missing replica is valid; excessive lag is not.
  const replicaLag = await withTimeout(
    pool.checkReplicaLag(),
    CHECK_TIMEOUT_MS,
    "readReplicaLag",
  );
  if (!replicaLag.ok) {
    checks.readReplicaLag = {
      status: "unknown",
      reason: replicaLag.reason,
    };
  } else if (!replicaLag.value.hasReplica) {
    checks.readReplicaLag = { status: "skipped", hasReplica: false };
  } else if (replicaLag.value.lagMs === null) {
    checks.readReplicaLag = {
      status: "unknown",
      hasReplica: true,
      reason: replicaLag.value.error || "Cannot check replica lag",
    };
  } else if (replicaLag.value.lagMs > MAX_REPLICA_LAG_MS) {
    checks.readReplicaLag = {
      status: "degraded",
      hasReplica: true,
      lagMs: replicaLag.value.lagMs,
      maxLagMs: MAX_REPLICA_LAG_MS,
      reason: `Replica lag ${replicaLag.value.lagMs}ms exceeds ${MAX_REPLICA_LAG_MS}ms`,
    };
  } else {
    checks.readReplicaLag = {
      status: "ok",
      hasReplica: true,
      lagMs: replicaLag.value.lagMs,
      maxLagMs: MAX_REPLICA_LAG_MS,
    };
  }

  // Redis (optional — only checked if REDIS_URL is set)
  if (process.env.REDIS_URL) {
    try {
      const redis = require("../services/redis");
      const c = redis.getClient();
      const pong = await withTimeout(c.ping(), CHECK_TIMEOUT_MS, "redis");
      checks.redis =
        pong.ok && pong.value === "PONG"
          ? { status: "ok" }
          : { status: "unreachable", reason: pong.reason || "no PONG" };
    } catch (err) {
      checks.redis = { status: "unreachable", reason: err.message };
    }
  }

  // Horizon (best-effort)
  const horizon = await withTimeout(
    fetch(`${HORIZON_URL}/fee_stats`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    }),
    CHECK_TIMEOUT_MS + 100,
    "horizon",
  );
  checks.horizon =
    horizon.ok && horizon.value.ok
      ? { status: "ok" }
      : { status: "unreachable", reason: horizon.reason || "non-2xx" };

  // Soroban RPC (best-effort — max 1 retry so the probe stays fast)
  // Uses withRetry with maxRetries=1 rather than 0 to account for one
  // transient hiccup, but we don't run the full 3-retry backoff here since
  // we want the readiness response to be snappy.
  const sorobanResult = await withTimeout(
    withRetry(() => rpcServer.getLatestLedger(), 1),
    CHECK_TIMEOUT_MS,
    "soroban_rpc",
  );
  checks.soroban_rpc = sorobanResult.ok
    ? { status: "ok" }
    : { status: "degraded", reason: sorobanResult.reason || "RPC unreachable" };

  // Indexer (process-local — does not block on the network)
  try {
    const indexerService = require("../services/indexerService");
    const s = indexerService.getStatus();
    checks.indexer = { status: s.running ? "ok" : "degraded", ...s };
  } catch (err) {
    checks.indexer = { status: "unknown", reason: err.message };
  }

  const replicaOk = checks.readReplicaLag.status !== "degraded";
  const requiredOk =
    checks.db.status === "ok" &&
    checks.pool.status === "ok" &&
    replicaOk;
  const ready = requiredOk && !isShuttingDown();

  if (!ready) {
    const reason =
      checks.db.status !== "ok"
        ? "db"
        : checks.pool.status !== "ok"
          ? "db_pool_degraded"
          : checks.readReplicaLag.status === "degraded"
            ? "readReplicaLag"
            : "draining";
    metrics.metrics.readinessCheckFailedTotal.inc({ reason });
    logger.warn(
      { event: "readiness_failed", checks },
      "Readiness check failed; pod should be removed from rotation",
    );
  }

  return res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "not ready",
    timestamp: new Date().toISOString(),
    checks,
  });
});

module.exports = router;
