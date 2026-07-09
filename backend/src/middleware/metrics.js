/**
 * src/middleware/metrics.js
 *
 * Per-request HTTP metrics middleware. MUST be mounted after
 * pino-http (so req.log / req.id is available) and before the route
 * handlers (so the histogram observation captures the full request
 * including the handler and any auth work).
 *
 * The `res.on("finish")` hook fires AFTER Express has finalised the
 * response status, which is the only safe point to read res.statusCode.
 */
"use strict";

const {
  normaliseRoute,
  metrics: m,
} = require("../services/metrics");

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);

function metricsMiddleware(req, res, next) {
  const method = ALLOWED_METHODS.has(req.method) ? req.method : "OTHER";
  // The in-flight gauge is labelled by method only — the matched route
  // is not known at middleware entry time, and using the raw URL would
  // let a misbehaving client explode the cardinality. The counter and
  // histogram (recorded on response finish) get the full (method, route,
  // status_code) labels.
  m.httpRequestsInFlight.inc({ method });
  const startNs = process.hrtime.bigint();
  let recorded = false;

  function record() {
    if (recorded) return; // never double-count
    recorded = true;
    const route = normaliseRoute(req);
    // If the client disconnected before the response was written, the
    // default 200 status would inflate the success counter. Tag these
    // as 499 (nginx convention for client-closed) so the histogram
    // stays accurate.
    const statusCode = res.headersSent ? String(res.statusCode) : "499";
    const durationSeconds = Number(process.hrtime.bigint() - startNs) / 1e9;
    m.httpRequestsInFlight.dec({ method });
    m.httpRequestsTotal.inc({ method, route, status_code: statusCode });
    m.httpRequestDurationSeconds.observe(
      { method, route, status_code: statusCode },
      durationSeconds
    );
  }

  // `finish` fires when the response is fully sent. `close` fires when
  // the underlying connection terminates — even if the response was
  // never completed (client abort, TCP reset, SSE drop). We register
  // both and the `recorded` flag ensures the metrics are only emitted
  // once per request.
  res.on("finish", record);
  res.on("close", record);

  next();
}

module.exports = metricsMiddleware;
