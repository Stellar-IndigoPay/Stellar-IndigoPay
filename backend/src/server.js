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
const http = require("http");
const { Server } = require("socket.io");

const logger = require("./logger");
const requestLogger = require("./middleware/requestLogger");
const requestId = require("./middleware/requestId");
const queryRouter = require("./middleware/queryRouter");
const metricsMiddleware = require("./middleware/metrics");
const {
  createCorsMiddleware,
  getAllowedOrigins,
} = require("./middleware/corsPolicy");
const { runMigrations } = require("./db/migrate");
const { startTurretsServer } = require("./services/turrets");
const { start: startSummaryQueue } = require("./services/summaryQueue");
const { start: startProfileQueue } = require("./services/profileQueue");
const {
  start: startWebhookQueue,
  stop: stopWebhookQueue,
} = require("./services/webhookQueue");
const { start: startPushQueue } = require("./services/pushQueue");
const { startIndexer } = require("./services/indexerService");
const lifecycle = require("./services/lifecycle");

Sentry.init({
  dsn: process.env.SENTRY_DSN || "",
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0.1),
  environment: process.env.NODE_ENV,
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
app.use("/api/health", require("./routes/health"));
app.use("/api/readyz", require("./routes/readiness"));

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

// ── 404 + error handling ────────────────────────────────────────────────────
app.use((req, res) =>
  res.status(404).json({ error: `${req.method} ${req.path} not found` }),
);

// Sentry error handler captures the exception and emits a transaction.
app.use(Sentry.Handlers.errorHandler());

app.use((err, req, res, _next) => {
  try {
    Sentry.captureException(err);
  } catch {
    // Sentry may be uninitialised in tests — never let it block the response.
  }
  logger.error(
    {
      event: "request_error",
      err: err.message,
      path: req.path,
      method: req.method,
    },
    err.message,
  );
  res
    .status(err.status || 500)
    .json({ error: err.message || "Internal server error" });
});

// ── Socket.IO ──────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: origins,
    methods: ["GET", "POST"],
    credentials: false,
  },
});
app.set("io", io);

// ── Background workers (registered with the lifecycle so they stop on shutdown)
async function startServer() {
  await runMigrations();
  await startSummaryQueue(io);
  await startProfileQueue(io);
  await startWebhookQueue();
  await startPushQueue();

  // digestQueue is optional in some deployments
  try {
    const { start: startDigestQueue } = require("./services/digestQueue");
    await startDigestQueue();
  } catch (err) {
    logger.warn(
      { event: "digest_queue_disabled", err: err.message },
      "digestQueue could not be started",
    );
  }

  startIndexer(io).catch((err) =>
    logger.error(
      { event: "indexer_startup_error", err: err.message },
      "Indexer failed to start",
    ),
  );

  // The Stellar Horizon stream in the indexer holds the event loop open.
  // Register a shutdown hook so the stream is closed cleanly on SIGTERM.
  lifecycle.onShutdown(async () => {
    try {
      const indexer = require("./services/indexerService");
      if (typeof indexer.stop === "function") await indexer.stop();
    } catch {
      // Indexer may already be stopped; swallow.
    }
  });

  // pg-boss queues: each one exposes a `stop()` method that drains in-flight
  // jobs. We register one hook per queue so a failure in one doesn't stop
  // the others from draining.
  for (const queue of [
    "./services/summaryQueue",
    "./services/profileQueue",
    "./services/digestQueue",
    "./services/webhookQueue",
    "./services/pushQueue",
  ]) {
    lifecycle.onShutdown(async () => {
      try {
        const mod = require(queue);
        if (mod && typeof mod.stop === "function") await mod.stop();
      } catch {
        // Module may not be loaded; swallow.
      }
    });
  }

  // Socket.IO: stop accepting new connections, wait for in-flight, then close.
  lifecycle.onShutdown(async () => {
    await new Promise((resolve) => io.close(resolve));
  });

  // Database pool: end all idle clients.
  lifecycle.onShutdown(async () => {
    try {
      const pool = require("./db/pool");
      await pool.end();
    } catch (err) {
      logger.warn(
        { event: "pool_close_error", err: err.message },
        "pool.end() failed during shutdown",
      );
    }
  });

  // Redis: close the connection (non-fatal if it was never opened).
  lifecycle.onShutdown(async () => {
    try {
      const redis = require("./services/redis");
      const c = redis.getClient();
      await c.quit();
    } catch {
      // Redis is optional; ignore.
    }
  });

  // Sentry: flush any buffered events before the process exits.
  lifecycle.onShutdown(async () => {
    try {
      await Sentry.close(2000);
    } catch {
      // ignore
    }
  });

  server.listen(PORT, () => {
    logger.info(
      { event: "server_listening", port: PORT },
      `Server listening on :${PORT}`,
    );
  });

  if (process.env.ENABLE_TURRETS === "true") {
    const turretsPort = process.env.TURRETS_PORT || 3001;
    startTurretsServer(turretsPort);
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
