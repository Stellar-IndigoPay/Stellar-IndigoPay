"use strict";

const { getReader, getWriter, runWithQueryRole } = require("../db/pool");

function isReadOnlyMethod(method) {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

function queryRouter(req, _res, next) {
  const method = String(req.method || "").toUpperCase();
  const isReadOnly = isReadOnlyMethod(method);

  req.getReader = getReader;
  req.getWriter = getWriter;
  req.getClient = isReadOnly ? getReader : getWriter;

  return runWithQueryRole(method, next);
}

module.exports = queryRouter;
