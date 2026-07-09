"use strict";

const { Pool } = require("pg");

const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/indigopay";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  max: parseInt(process.env.DB_POOL_MAX || "20", 10),
  idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT || "30000", 10),
  // Lowered to 1s so connection acquire + statement timeout stays under
  // the readiness probe's 4s deadline (1s + 3s = 4s on the nose).
  connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_TIMEOUT || "1000", 10),
  // Bound the runtime of any single statement. Without this, a slow
  // query could hold a pool connection until the client times out,
  // which can exhaust the pool when /api/readyz is polled aggressively.
  // Default 3s — MUST be shorter than the readiness check timeout (4s)
  // so the DB query is cancelled BEFORE /api/readyz reports 503, freeing
  // the pool connection in time for the next probe.
  statement_timeout: parseInt(process.env.DB_STATEMENT_TIMEOUT_MS || "3000", 10),
});

pool.on("error", (err) => {
  console.error("[Postgres] Unexpected client error:", err.message);
});

module.exports = pool;
