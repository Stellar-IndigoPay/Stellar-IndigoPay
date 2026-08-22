/**
 * src/server.js — Stellar-IndigoPay API
 *
 * Bootstrap order (matters):
 *   1. Env validation + dotenv
 *   2. Sentry init (before anything that could throw)
 *   3. Express app + http.Server
 *   4. Sentry request handler (first middleware)
 *   5. pino-http request logger (sets req.id / correlationId)
 *   6. X-Request-Id response header
 *   7. /metrics endpoint (unauth in dev, bearer-token in prod)
 *   8. /api/health (liveness) + /api/readyz (readiness) — no auth, no CSRF
 *   9. /api/csrf-token endpoint
 *  10. Helmet + CORS + JSON parser + cookie-parser
 *  11. CSRF (skipped for the notification routes that need cross-origin POSTs)
 *  12. Rate limiter
 *  13. Per-request metrics middleware (BEFORE route handlers so it captures the full request)
 *  14. /api/docs Swagger UI (dev only)
 *  15. /api/* and /api/v1/* route mounts
 *  16. 404 handler
 *  17. Sentry error handler
 *  18. Custom error handler
 */
"use strict";

require("dotenv").config();

// Validate the environment up-front so the process exits cleanly on misconfig
// rather than failing on the first request that touches a missing var.
const { validateEnv } = require("./config/env");
validateEnv();

const Sentry = require("@sentry/node");
const Tracing = require("@sentry/tracing");
const express = require("express");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const csurf = require("csurf");
const { redisRateLimiter } = require("./middleware/rateLimiter");
const { socketAuth } = require("./middleware/socketAuth");
const http = require("http");
const { Server } = require("socket.io");

const logger = require("./logger");
const requestLogger = require("./middleware/requestLogger");
const requestId = require("./middleware/requestId");
const queryRouter = require("./middleware/queryRouter");
const {
  apiVersionMiddleware,
  registerApiVersionDiscoveryRoutes,
} = require("./middleware/apiVersion");
const metricsMiddleware = require("./middleware/metrics");
const { refreshDbPoolMetrics } = require("./services/metrics");
const {
  createCorsMiddleware,
  getAllowedOrigins,
} = require("./middleware/corsPolicy");
const { runMigrations } = require("./db/migrate");
const { AppError } = require("./errors");
const { startTurretsServer } = require("./services/turrets");
const summaryQueue = require("./services/summaryQueue");
const profileQueue = require("./services/profileQueue");
const matchQueue = require("./services/matchQueue");
const webhookQueue = require("./services/webhookQueue");
const pushQueue = require("./services/pushQueue");
const impactQueue = require("./services/impactQueue");
const idempotencyCleanup = require("./services/idempotencyCleanup");
const recurringDonationWorker = require("./services/recurringDonationWorker");
const blacklistCleanup = require("./services/blacklistCleanup");
const { startCO2VerificationCron, stopCO2VerificationCron } = require("./services/co2Verifier");
const indexerService = require("./services/indexerService");
const { startReconciler, stopReconciler } = require("./services/indexerReconciler");
const { startDLQWorker, stopDLQWorker } = require("./services/indexerDLQWorker");
const sorobanEventService = require("./services/sorobanEventService");
const lifecycle = require("./services/lifecycle");
const { startManagedWorker } = require("./services/workerLifecycle");
const guardianService = require("./services/guardian");
const recurringKeeper = require("./services/recurringKeeper");



Sentry.init({
  dsn: process.env.SENTRY_DSN || "",
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  environment: process.env.NODE_ENV,
  // Group events by our own error code (set via `extra.errorCode` at the
  // capture site) instead of Sentry's default message-based grouping,
  // which is fragile — two different bugs that happen to interpolate the
  // same words into their message would otherwise collapse into one issue.
  beforeSend(event) {
    if (event.extra?.errorCode) {
      event.fingerprint = [String(event.extra.errorCode)];
    }
    return event;
  },
});

const app = express();
const PORT = process.env.PORT || 4000;
const SHUTDOWN_TIMEOUT_MS = Number(process.env.SHUTDOWN_TIMEOUT_MS || 30_000);
const server = http.createServer(app);

// ── Core middleware (order matters) ─────────────────────────────────────────

// Sentry: must be first so all subsequent errors/metrics carry the request.
app.use(Sentry.Handlers.requestHandler());
app.use(Sentry.Handlers.tracingHandler());

// pino-http sets req.id (correlationId). It MUST come before requestId and
// metrics so they can both read req.id.
app.use(requestLogger);
app.use(requestId);
app.use(queryRouter);

// /metrics: bearer-token auth in prod, unauth in dev. Mounted before
// helmet/CSRF so Prometheus can scrape without a CSRF token.
app.use("/", require("./routes/metrics"));

// Health and readiness: liveness 200 if alive, readiness 200 only when every
// required downstream is reachable. Both fail-fast during graceful shutdown.
//
// /health/ready is mounted at a separate path (before helmet/CSRF) so the
// CI/CD secret-rotation workflow can call it without authentication. It uses
// the same readiness handler as /api/readyz — both validate every external
// dependency (Postgres, Redis, Horizon, Soroban RPC).
app.use("/api/health", require("./routes/health"));
app.use("/api/readyz", require("./routes/readiness"));
app.use("/health/ready", require("./routes/readiness"));

// Security headers and body parsing.
app.use(
  helmet({
    contentSecurityPolicy: false, // we set our own CSP below
  }),
);
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'",
  );
  next();
});
app.use(express.json({ limit: "20kb" }));
app.use(cookieParser());

const csrfProtection = csurf({
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
    path: "/",
  },
  ignoreMethods: ["GET", "HEAD", "OPTIONS"],
});
// Endpoints whose only credential is the refresh cookie. SameSite=Strict keeps
// that cookie off every cross-site request, so a CSRF token would cost the
// admin client a round-trip without closing an attack path. Listed per mount
// because this router answers on both /api and /api/v1.
const COOKIE_AUTH_PATHS = ["/admin/refresh", "/admin/logout"].flatMap((path) => [
  `/api${path}`,
  `/api/v1${path}`,
]);

app.use((req, res, next) => {
  // Push-notification endpoints accept cross-origin POSTs from device tokens
  // (mobile apps don't have a CSRF session), so CSRF is skipped there.
  // The CSRF-token endpoint is NOT skipped: csurf's ignoreMethods
  // already short-circuits validation for GET requests while still
  // attaching `req.csrfToken()` to the request. Skipping the middleware
  // entirely would leave `req.csrfToken` undefined.
  if (
    req.path.startsWith("/api/notifications") ||
    req.path.startsWith("/api/v1/notifications")
  ) {
    return next();
  }
  if (COOKIE_AUTH_PATHS.includes(req.path)) {
    return next();
  }
  return csrfProtection(req, res, next);
});

// CSRF token endpoint — MUST be registered AFTER the csurf middleware so
// that `req.csrfToken()` has been attached to the request. csurf sets
// the helper on every request that flows through it (even GETs, via
// ignoreMethods), so the order matters: middleware first, then handler.
function csrfTokenHandler(req, res) {
  res.json({ success: true, csrfToken: req.csrfToken() });
}
app.get("/api/csrf-token", csrfTokenHandler);
app.get("/api/v1/csrf-token", csrfTokenHandler);

const origins = getAllowedOrigins();
app.use(...createCorsMiddleware(origins));

// Rate limit AFTER CSRF so a flood of token requests doesn't get
// rate-limited (CSRF failures need to be visible to the limiter logic).
// Uses Redis-backed sliding window per-endpoint rate limiter with
// in-memory fallback when Redis is unavailable.
app.use(redisRateLimiter);

// Per-request HTTP metrics (BEFORE routes so it captures the full request).
app.use(metricsMiddleware);

// API version negotiation (header/path/query) + deprecation/sunset signaling.
app.use("/api", apiVersionMiddleware);
app.use("/api/v1", apiVersionMiddleware);
registerApiVersionDiscoveryRoutes(app);

// ── Swagger UI (development only) ───────────────────────────────────────────
if (process.env.NODE_ENV !== "production") {
  try {
    const swaggerUi = require("swagger-ui-express");
    const yaml = require("js-yaml");
    const fs = require("fs");
    const path = require("path");
    const swaggerPath = path.join(__dirname, "../../docs/api/openapi.yaml");
    if (fs.existsSync(swaggerPath)) {
      const swaggerDoc = yaml.load(fs.readFileSync(swaggerPath, "utf8"));
      app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc));
    }
  } catch (err) {
    logger.warn(
      { event: "swagger_ui_disabled", err: err.message },
      "Swagger UI could not be mounted",
    );
  }
}

// Admin event service routes — mounted BEFORE the main admin router so that
// /api/admin/* paths for specific sub-routers are matched before the generic
// admin catch-all.
try {
  const adminEventsRouter = require("./routes/admin/events");
  app.use("/api/admin/events", adminEventsRouter);
  app.use("/api/v1/admin/events", adminEventsRouter);
} catch (err) {
  logger.error(
    { event: "route_load_failed", route: "admin/events", err: err.message },
    "Failed to load admin events route module",
  );
}

try {
  const adminAnalyticsRouter = require("./routes/admin/analytics");
  app.use("/api/admin/analytics", adminAnalyticsRouter);
  app.use("/api/v1/admin/analytics", adminAnalyticsRouter);
} catch (err) {
  logger.error(
    { event: "route_load_failed", route: "admin/analytics", err: err.message },
    "Failed to load admin analytics route module",
  );
}

// Admin projection-engine management (event-sourcing rebuild endpoints).
try {
  const adminProjectionsRouter = require("./routes/admin/projections");
  app.use("/api/admin/projections", adminProjectionsRouter);
  app.use("/api/v1/admin/projections", adminProjectionsRouter);
} catch (err) {
  logger.error(
    { event: "route_load_failed", route: "admin/projections", err: err.message },
    "Failed to load admin projections route module",
  );
}

// ── Application routes ──────────────────────────────────────────────────────
// Each route file is mounted under both /api and /api/v1 so that the v1
// versioned path and the legacy unversioned path stay in lockstep.
const routeMounts = [
  "donations",
  "projects",
  "profiles",
  "leaderboard",
  "ratings",
  "stats",
  "updates",
  "admin",
  "jobs",
  "subscriptions",
  "uploads",
  "impact",
  "notifications",
  "verification",
  "oracle",
  "map",
  "matches",
  "turrets",
];

for (const name of routeMounts) {
  try {
    const router = require(`./routes/${name}`);
    app.use(`/api/${name}`, router);
    app.use(`/api/v1/${name}`, router);
    if (name === "verification") {
      app.use("/api/verification-requests", router);
      app.use("/api/v1/verification-requests", router);
    }
  } catch (err) {
    logger.error(
      { event: "route_load_failed", route: name, err: err.message },
      "Failed to load route module",
    );
  }
}

// Analytics is mounted under /api/projects so the route handler receives
// requests at /api/projects/:id/analytics (issue #71).
try {
  const analyticsRouter = require("./routes/analytics");
  app.use("/api/projects", analyticsRouter);
  app.use("/api/v1/projects", analyticsRouter);
} catch (err) {
  logger.error(
    { event: "route_load_failed", route: "analytics", err: err.message },
    "Failed to load analytics route module",
  );
}

// Cross-chain donation attestation bridge (issue #125). The route file
// exports an Express router that handles reads, writes, proof minting,
// verification, and admin revoke. It is mounted under both the legacy
// unversioned and the /v1 paths so existing callers keep working.
try {
  const attestationsRouter = require("./routes/attestations");
  app.use("/api/attestations", attestationsRouter);
  app.use("/api/v1/attestations", attestationsRouter);
} catch (err) {
  logger.error(
    { event: "route_load_failed", route: "attestations", err: err.message },
    "Failed to load attestations route module",
  );
}

// ── 404 + error handling ────────────────────────────────────────────────────

// Best-effort code for 4xx errors raised outside AppError (library/middleware
// errors that carry a `.status` but aren't one of our own error classes).
const STATUS_FALLBACK_CODE = {
  400: "VALIDATION_ERROR",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "VALIDATION_ERROR",
  413: "FILE_TOO_LARGE",
  422: "SCHEMA_VALIDATION_ERROR",
  429: "RATE_LIMITED",
};

app.use((req, res) =>
  res.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: `${req.method} ${req.path} not found`,
    },
  }),
);

// Sentry error handler captures the exception and emits a transaction.
app.use(Sentry.Handlers.errorHandler());

/**
 * Central error-handling middleware. Extracted to a named function (rather
 * than an inline arrow passed to `app.use`) so it can be unit-tested
 * directly — see `errorHandler.test.js`.
 */
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    // 4xx AppErrors are expected client-facing traffic (validation, auth,
    // not-found, …) and are intentionally never sent to Sentry. 5xx
    // AppErrors (DB_ERROR, RPC_ERROR, …) are genuine server-side failures
    // even though they're wrapped in a structured error, so those are
    // still captured — fingerprinted by code via the beforeSend hook above.
    if (err.status >= 500) {
      try {
        Sentry.captureException(err, { extra: { errorCode: err.code } });
      } catch {
        // Sentry may be uninitialised in tests — never let it block the response.
      }
    }
    logger.error(
      {
        event: "request_error",
        code: err.code,
        err: err.message,
        path: req.path,
        method: req.method,
      },
      err.message,
    );
    return res.status(err.status).json(err.toJSON());
  }

  // A non-AppError with a 4xx status is a known, expected client error
  // raised by a library ahead of our routes (e.g. csurf's "invalid csrf
  // token"). It isn't an AppError instance, but it's not a bug either —
  // surface its own status/message (safe: these come from trusted
  // middleware, not raw internals) under a best-effort code, and skip
  // Sentry the same way a 4xx AppError would.
  if (err.status && err.status < 500) {
    const code = STATUS_FALLBACK_CODE[err.status] || "VALIDATION_ERROR";
    logger.warn(
      {
        event: "request_error",
        code,
        err: err.message,
        path: req.path,
        method: req.method,
      },
      err.message,
    );
    return res
      .status(err.status)
      .json({ error: { code, message: err.message } });
  }

  // Truly unhandled errors — always a bug, so always captured and always
  // reported to the client as a generic INTERNAL_ERROR (never leak
  // err.message, which may contain internals like a raw DB or SDK error).
  try {
    Sentry.captureException(err, { extra: { errorCode: "INTERNAL_ERROR" } });
  } catch {
    // Sentry may be uninitialised in tests — never let it block the response.
  }
  logger.error(
    {
      event: "unhandled_error",
      err: err.message,
      path: req.path,
      method: req.method,
    },
    err.message,
  );
  res.status(500).json({
    error: { code: "INTERNAL_ERROR", message: "Internal server error" },
  });
}

app.use(errorHandler);

// ── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: origins,
    methods: ["GET", "POST"],
    credentials: false,
  },
});
// Realtime events carry donor-identifying data: refuse every connection that
// cannot prove itself with the same access token the REST layer requires.
io.use(socketAuth);
app.set("io", io);

// ── Background workers (registered with the lifecycle so they stop on shutdown)
async function startOptionalWorker(config) {
  try {
    await startManagedWorker(config);
  } catch {
    // Optional workers report their own structured startup error.
  }
}

async function startServer() {
  await runMigrations();
  await startManagedWorker({
    name: "summary_queue",
    label: "Summary queue",
    start: () => summaryQueue.start(io),
    stop: summaryQueue.stop,
  });
  await startManagedWorker({
    name: "profile_queue",
    label: "Profile queue",
    start: () => profileQueue.start(io),
    stop: profileQueue.stop,
  });
  await startManagedWorker({
    name: "match_queue",
    label: "Match queue",
    start: matchQueue.start,
    stop: matchQueue.stop,
  });
  await startManagedWorker({
    name: "webhook_queue",
    label: "Webhook queue",
    start: webhookQueue.start,
    stop: webhookQueue.stop,
  });
  await startManagedWorker({
    name: "push_queue",
    label: "Push queue",
    start: pushQueue.start,
    stop: pushQueue.stop,
  });
  await startManagedWorker({
    name: "impact_queue",
    label: "Impact queue",
    start: () => impactQueue.start(io),
    stop: impactQueue.stop,
  });
  await startManagedWorker({
    name: "idempotency_cleanup",
    label: "Idempotency cleanup",
    start: idempotencyCleanup.start,
    stop: idempotencyCleanup.stop,
  });
  await startManagedWorker({
    name: "recurring_donation_worker",
    label: "Recurring donation worker",
    start: () => recurringDonationWorker.start(io),
    stop: recurringDonationWorker.stop,
  });
  await startManagedWorker({
    name: "blacklist_cleanup",
    label: "Blacklist cleanup",
    start: blacklistCleanup.start,
    stop: blacklistCleanup.stop,
  });
  await startOptionalWorker({
    name: "co2_verification_cron",
    label: "CO2 verification cron",
    start: startCO2VerificationCron,
    stop: stopCO2VerificationCron,
  });

  // Match expiry: deactivates pools that have expired (time-based) or been
  // exhausted (cap reached). Runs every 15 minutes.
  const matchExpiry = require("./services/matchExpiry");
  await startOptionalWorker({
    name: "match_expiry",
    label: "Match expiry service",
    start: matchExpiry.start,
    stop: matchExpiry.stop,
  });

  // Retention worker: a dedicated pg-boss instance schedules the config-driven
  // data-retention policies. Kept separate from the request queues so a
  // retention failure can never interfere with donation/delivery processing.
  let retentionBoss;
  await startOptionalWorker({
    name: "retention_worker",
    label: "Retention worker",
    start: async () => {
      const PgBoss = require("pg-boss");
      const { registerRetentionWorker } = require("./services/retentionWorker");
      retentionBoss = new PgBoss(
        process.env.DATABASE_URL ||
          "postgres://postgres:postgres@localhost:5432/indigopay",
      );
      retentionBoss.on("error", (err) =>
        logger.error(
          { event: "retention_boss_error", err: err.message },
          "retention pg-boss error",
        ),
      );
      await retentionBoss.start();
      await registerRetentionWorker(retentionBoss);
    },
    stop: () => retentionBoss.stop(),
  });

  // digestQueue is optional in some deployments
  const digestQueue = require("./services/digestQueue");
  await startOptionalWorker({
    name: "digest_queue",
    label: "Digest queue",
    start: digestQueue.start,
    stop: digestQueue.stop,
  });

  await startOptionalWorker({
    name: "indexer",
    label: "Indexer",
    start: () => indexerService.startIndexer(io),
    stop: indexerService.stop,
  });
  await startOptionalWorker({
    name: "indexer_reconciler",
    label: "Indexer reconciler",
    start: startReconciler,
    stop: stopReconciler,
  });
  await startOptionalWorker({
    name: "indexer_dlq_worker",
    label: "Indexer DLQ worker",
    start: startDLQWorker,
    stop: stopDLQWorker,
  });

  const oracleService = require("./services/oracleService");
  await startOptionalWorker({
    name: "oracle_service",
    label: "Oracle service",
    start: oracleService.start,
    stop: oracleService.stop,
  });
  await startOptionalWorker({
    name: "guardian_service",
    label: "Guardian service",
    start: guardianService.start,
    stop: guardianService.stop,
  });
  await startOptionalWorker({
    name: "recurring_keeper",
    label: "Recurring keeper",
    start: recurringKeeper.start,
    stop: recurringKeeper.stop,
  });

  // Soroban event service: start the polling loop.
  await startOptionalWorker({
    name: "soroban_events",
    label: "Soroban event service",
    start: () => sorobanEventService.start(io),
    stop: sorobanEventService.stop,
  });

  await startManagedWorker({
    name: "socket_io",
    label: "Socket.IO",
    start: () => {},
    stop: () => new Promise((resolve) => io.close(resolve)),
  });

  const pool = require("./db/pool");
  await startManagedWorker({
    name: "database_pool",
    label: "Database pool",
    start: () => {},
    stop: pool.end,
  });

  const redis = require("./services/redis");
  let redisClient;
  await startManagedWorker({
    name: "redis",
    label: "Redis",
    start: () => {
      redisClient = redis.getClient();
    },
    stop: () => redisClient.quit(),
  });

  await startManagedWorker({
    name: "sentry",
    label: "Sentry",
    start: () => {},
    stop: () => Sentry.close(2000),
  });

  let metricsTimer;
  await startManagedWorker({
    name: "db_pool_metrics",
    label: "Database pool metrics",
    start: () => {
      metricsTimer = setInterval(
        () => refreshDbPoolMetrics(pool._writerPool),
        15000,
      );
      if (typeof metricsTimer.unref === "function") metricsTimer.unref();
    },
    stop: () => clearInterval(metricsTimer),
  });

  server.listen(PORT, () => {
    logger.info(
      { event: "server_listening", port: PORT },
      `Server listening on :${PORT}`,
    );
  });

  if (process.env.ENABLE_TURRETS === "true") {
    const turretsPort = process.env.TURRETS_PORT || 3001;
    let turretsServer;
    await startOptionalWorker({
      name: "turrets_server",
      label: "Turrets server",
      start: () =>
        new Promise((resolve, reject) => {
          turretsServer = startTurretsServer(turretsPort);
          turretsServer.once("listening", resolve);
          turretsServer.once("error", reject);
        }),
      stop: () =>
        new Promise((resolve, reject) => {
          turretsServer.close((err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
    });
  }
}

// ── Graceful shutdown wiring ───────────────────────────────────────────────
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  lifecycle.beginShutdown();
  logger.warn(
    { event: "shutdown_started", signal },
    `Received ${signal}, beginning graceful shutdown`,
  );

  // Hard deadline — if the in-flight drain takes too long, exit anyway.
  const deadline = setTimeout(() => {
    logger.error(
      { event: "shutdown_timeout", timeoutMs: SHUTDOWN_TIMEOUT_MS },
      "Forced exit after timeout",
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  deadline.unref();

  try {
    // 1. Stop accepting new connections. In-flight requests continue.
    await new Promise((resolve) => server.close(resolve));
    logger.info({ event: "http_server_closed" }, "HTTP server closed");

    // 2. Run all registered lifecycle handlers (queues, db, redis, sentry).
    await lifecycle.runShutdownHandlers();
    logger.info({ event: "shutdown_complete" }, "Graceful shutdown complete");
    clearTimeout(deadline);
    process.exit(0);
  } catch (err) {
    logger.error(
      { event: "shutdown_error", err: err.message },
      "Error during shutdown",
    );
    clearTimeout(deadline);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  logger.fatal({ event: "uncaught_exception", err: err.message }, err.message);
  // Don't exit immediately — log + report, then shut down so we don't leave
  // a half-broken process serving traffic.
  gracefulShutdown("uncaughtException");
});
process.on("unhandledRejection", (reason) => {
  logger.error(
    { event: "unhandled_rejection", reason: String(reason) },
    "Unhandled promise rejection",
  );
});

if (require.main === module) {
  startServer().catch((err) => {
    logger.fatal({ event: "startup_error", err: err.message }, err.message);
    process.exit(1);
  });
}

module.exports = app;
// Exposed for direct unit testing (see errorHandler.test.js) without
// changing the primary export other code already relies on (`require("./server")`
// resolving to the Express app instance).
module.exports.errorHandler = errorHandler;
