/**
 * src/middleware/requestId.js
 *
 * Surface the per-request correlation id (set by pino-http) as the
 * `X-Request-Id` response header. By convention we use the SAME id
 * already on req.id so that downstream log lines, Sentry breadcrumbs,
 * and the client can all agree on a single request identifier.
 *
 * The header MUST be set BEFORE res.writeHead is called. pino-http
 * stores the id on req.id (we set it in genReqId), so we read it on
 * the synchronous middleware path and call res.setHeader immediately.
 */
"use strict";

const HEADER_NAME = "X-Request-Id";

function requestIdMiddleware(req, res, next) {
  const id = req.id || req.headers["x-request-id"];
  if (id && !res.getHeader(HEADER_NAME)) {
    res.setHeader(HEADER_NAME, String(id));
  }
  next();
}

module.exports = requestIdMiddleware;
module.exports.HEADER_NAME = HEADER_NAME;
