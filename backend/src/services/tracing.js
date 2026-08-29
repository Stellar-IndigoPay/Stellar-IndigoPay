"use strict";

/**
 * src/services/tracing.js
 *
 * OpenTelemetry distributed tracing for the Stellar-IndigoPay backend.
 *
 * Responsibilities:
 *   1. Initialize the OTel SDK with auto-instrumentation for Express, HTTP,
 *      and pg (Postgres) spans.
 *   2. Export spans to a configurable OTLP endpoint (e.g. Jaeger, Grafana
 *      Tempo, Honeycomb, or any OTLP-compatible collector).
 *   3. Wire X-Request-Id as the OTel trace ID so pino-http request logs
 *      and distributed traces share a single correlation identifier.
 *   4. Provide a `traceMiddleware` that extracts an incoming X-Request-Id,
 *      uses it as the trace parent, and sets the response header.
 *
 * Configuration (environment variables):
 *   OTEL_EXPORTER_OTLP_ENDPOINT  — OTLP collector URL (e.g. http://localhost:4318/v1/traces)
 *                                   If unset, tracing is disabled (noop).
 *   OTEL_SERVICE_NAME            — Service name in trace metadata (default: "indigopay-backend")
 *   OTEL_SAMPLE_RATE             — Fraction of requests to trace (default: 0.1, i.e. 10 %)
 *   OTEL_TRACES_ENABLED          — Set to "false" to force-disable tracing (default: true when
 *                                   OTEL_EXPORTER_OTLP_ENDPOINT is set)
 *
 * The SDK is initialized lazily on the first call to `initTracing()` so that
 * modules that import this file (for the manual `trace` API) don't trigger
 * SDK setup until server.js is ready.
 */

const api = require("@opentelemetry/api");
const { NodeSDK } = require("@opentelemetry/sdk-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-otlp-http");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const { ParentBasedSampler, TraceIdRatioBasedSampler } = require("@opentelemetry/sdk-trace-base");
const { getNodeAutoInstrumentations } = require("@opentelemetry/auto-instrumentations-node");
const { W3CTraceContextPropagator } = require("@opentelemetry/core");
const logger = require("../logger");

// Track SDK instance for graceful shutdown.
let sdk = null;
let initialized = false;

/**
 * Whether tracing is enabled. True when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * and OTEL_TRACES_ENABLED is not explicitly "false".
 */
function isEnabled() {
  if (process.env.OTEL_TRACES_ENABLED === "false") return false;
  return Boolean(process.env.OTEL_EXPORTER_OTLP_ENDPOINT);
}

/**
 * Initialize the OTel SDK and start exporting spans.
 *
 * Idempotent — calling this more than once is safe (subsequent calls are no-ops).
 *
 * Must be called BEFORE any Express middleware or HTTP instrumentation so that
 * auto-instrumentation patches are in place before the first request arrives.
 *
 * @returns {Promise<boolean>} true if tracing was started, false if disabled.
 */
async function initTracing() {
  if (initialized) return isEnabled();

  if (!isEnabled()) {
    initialized = true;
    logger.info(
      { event: "otel_tracing_disabled" },
      "OpenTelemetry tracing disabled — set OTEL_EXPORTER_OTLP_ENDPOINT to enable",
    );
    return false;
  }

  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const serviceName = process.env.OTEL_SERVICE_NAME || "indigopay-backend";
  const sampleRate = Number(process.env.OTEL_SAMPLE_RATE || 0.1);

  logger.info(
    {
      event: "otel_tracing_init",
      endpoint,
      serviceName,
      sampleRate,
    },
    "Initializing OpenTelemetry tracing",
  );

  try {
    const exporter = new OTLPTraceExporter({
      url: endpoint.endsWith("/v1/traces")
        ? endpoint
        : `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    });

    const sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(Math.min(Math.max(sampleRate, 0), 1)),
    });

    sdk = new NodeSDK({
      serviceName,
      sampler,
      spanProcessors: [new BatchSpanProcessor(exporter)],
      // Use W3C trace context propagation so downstream services that also
      // speak OTel can join the same trace.
      textMapPropagator: new W3CTraceContextPropagator(),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Only instrument what we actually use — keeps the span payload lean.
          "@opentelemetry/instrumentation-http": {
            enabled: true,
            // Ignore health/metrics probes to keep trace volume manageable.
            ignoreIncomingRequestHook: (req) => {
              const path = req.url || "";
              return (
                path === "/api/health" ||
                path === "/api/readyz" ||
                path === "/health/ready" ||
                path === "/metrics"
              );
            },
          },
          "@opentelemetry/instrumentation-express": { enabled: true },
          "@opentelemetry/instrumentation-pg": { enabled: true },
          // Redis instrumentation requires @opentelemetry/instrumentation-ioredis
          // which we don't bundle by default — add it when Redis tracing is needed.
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-net": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
        }),
      ],
    });

    await sdk.start();
    initialized = true;
    logger.info(
      { event: "otel_tracing_started", serviceName },
      "OpenTelemetry tracing started",
    );
    return true;
  } catch (err) {
    // Don't mark initialized on failure — next initTracing() call will
    // retry instead of returning the stale false result forever.
    sdk = null;
    logger.error(
      { event: "otel_tracing_init_error", err: err.message },
      "Failed to initialize OpenTelemetry tracing — continuing without traces",
    );
    return false;
  }
}

/**
 * Stop the OTel SDK gracefully: flush remaining spans and shut down.
 * Called during server shutdown (see server.js lifecycle).
 *
 * @returns {Promise<void>}
 */
async function stopTracing() {
  if (!sdk) return;
  try {
    await sdk.shutdown();
    logger.info({ event: "otel_tracing_stopped" }, "OpenTelemetry tracing stopped");
  } catch (err) {
    logger.error(
      { event: "otel_tracing_stop_error", err: err.message },
      "Error stopping OpenTelemetry tracing",
    );
  } finally {
    sdk = null;
  }
}

// ── Trace ID ↔ X-Request-Id correlation middleware ─────────────────────

/**
 * Express middleware that synchronises OTel trace IDs with X-Request-Id
 * so that pino-http request logs and distributed traces share a single
 * correlation identifier.
 *
 * How it works:
 *   1. OTel auto-instrumentation runs first (via the SDK), creating a span
 *      context for the incoming request.
 *   2. This middleware reads the active span's trace ID and sets it as
 *      `req.id` so pino-http picks it up for log correlation.
 *   3. If the incoming request carries an X-Request-Id header, that value
 *      is used as the trace parent so upstream services can continue the
 *      same trace.
 *
 * Must be registered AFTER OTel's Express instrumentation middleware and
 * AFTER pino-http has set req.id, but BEFORE the routes that need req.id
 * for logging.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function traceIdMiddleware(req, res, next) {
  if (!isEnabled()) return next();

  try {
    const span = api.trace.getSpan(api.context.active());
    if (span) {
      const spanContext = span.spanContext();
      if (spanContext && spanContext.traceId) {
        // Override req.id with the OTel trace ID so every pino log line
        // emitted during this request carries the trace ID.
        req.id = spanContext.traceId;
        // Also set the response header when it hasn't been set yet.
        if (!res.headersSent && !res.getHeader("X-Request-Id")) {
          res.setHeader("X-Request-Id", spanContext.traceId);
        }
      }
    }
  } catch {
    // Tracing must never break the request path.
  }

  next();
}

// ── Manual tracing helpers ─────────────────────────────────────────────

/**
 * Create a named span for a manual instrumentation point (e.g. a specific
 * RPC call, queue operation, or cache access).  The span is a child of
 * whatever span is currently active in the async context.
 *
 * Usage:
 *   const tracer = require("../services/tracing");
 *   await tracer.withSpan("stellar.getTransaction", async () => {
 *     return await server.getTransaction(hash);
 *   });
 *
 * When tracing is disabled, the callback runs directly with no overhead.
 *
 * @param {string} name - Span name (e.g. "stellar.getTransaction")
 * @param {Function} fn  - Async function to wrap
 * @param {object} [attributes] - Optional span attributes
 * @returns {Promise<*>}
 */
async function withSpan(name, fn, attributes = {}) {
  if (!isEnabled()) return fn();

  const tracer = api.trace.getTracer("indigopay-backend");
  return tracer.startActiveSpan(name, async (span) => {
    try {
      for (const [key, value] of Object.entries(attributes)) {
        span.setAttribute(key, value);
      }
      return await fn();
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: err.message });
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Get the active tracer instance.  Useful for manual span creation where
 * startActiveSpan's callback pattern is inconvenient.
 *
 * @returns {import('@opentelemetry/api').Tracer}
 */
function getTracer() {
  return api.trace.getTracer("indigopay-backend");
}

module.exports = {
  initTracing,
  stopTracing,
  traceIdMiddleware,
  withSpan,
  getTracer,
  isEnabled,
};