"use strict";

const { context, propagation, trace, SpanStatusCode } = require("@opentelemetry/api");

const tracer = trace.getTracer("stellar-indigopay-backend");

// This is deliberately small: payload bodies, wallet addresses, e-mail addresses,
// URLs and arbitrary job fields must never become span attributes.
const ATTRIBUTE_ALLOWLIST = new Set([
  "deployment.environment.name", "http.request.method", "http.route",
  "http.response.status_code", "db.operation.name", "db.system.name",
  "messaging.destination.name", "messaging.operation.type", "service.name",
  "worker.name", "error.type",
]);

function safeAttributes(attributes = {}) {
  return Object.fromEntries(
    Object.entries(attributes).filter(([key, value]) =>
      ATTRIBUTE_ALLOWLIST.has(key) && ["string", "number", "boolean"].includes(typeof value)),
  );
}

async function withSpan(name, attributes, fn, parentContext = context.active()) {
  return tracer.startActiveSpan(name, { attributes: safeAttributes(attributes) }, parentContext, async (span) => {
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.setAttribute("error.type", err.name || "Error");
      throw err;
    } finally {
      span.end();
    }
  });
}

function injectTraceMetadata(data = {}) {
  const carrier = {};
  propagation.inject(context.active(), carrier);
  return { ...data, metadata: { ...(data.metadata || {}), traceparent: carrier.traceparent, tracestate: carrier.tracestate } };
}

function contextFromJob(data = {}) {
  const metadata = data.metadata || {};
  return propagation.extract(context.active(), {
    traceparent: metadata.traceparent,
    tracestate: metadata.tracestate,
  });
}

function httpTraceMiddleware(req, res, next) {
  const route = String(req.path || "/").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, ":id");
  withSpan("HTTP request", {
    "http.request.method": req.method,
    "http.route": route,
  }, (span) => new Promise((resolve) => {
    res.on("finish", () => {
      span.setAttribute("http.response.status_code", res.statusCode);
      resolve();
    });
    next();
  })).catch(next);
}

module.exports = { ATTRIBUTE_ALLOWLIST, contextFromJob, httpTraceMiddleware, injectTraceMetadata, safeAttributes, withSpan };
