/**
 * test/chaos/lib/harness.js
 *
 * Shared helpers for the chaos suite. Runs inside the backend container,
 * where the repo's real application modules live at /backend/src and the
 * backend image's node_modules are reachable via NODE_PATH=/app/node_modules.
 *
 * Responsibilities:
 *   - Marker-file protocol for host-injected faults (Redis/Postgres stop,
 *     handled by run-chaos.sh via docker compose). The driver writes
 *     `<scenario>.ready` → host injects fault → host writes `<scenario>.faulted`
 *     → driver writes `<scenario>.during` → host removes fault → host writes
 *     `<scenario>.recovered` → driver asserts recovery.
 *   - Fault injection against the chaos-stub (Horizon 503 / Soroban RPC 503
 *     or timeout) over its admin API.
 *   - DB seeding + assertions through the app's real `pool` module.
 *   - The request/response shim used to drive the real `recordDonation`
 *     handler directly (same pattern as donations.integration.test.js).
 */
"use strict";

const fs = require("fs");
const path = require("path");

// Allow the app's Stellar clients to talk to the plain-http chaos stub.
// Must run before ANY module that constructs Horizon.Server / rpc.Server
// (i.e. before requiring routes/donations or services/stellar).
require("@stellar/stellar-sdk").Config.setAllowHttp(true);

const RUN_DIR = process.env.CHAOS_RUN_DIR || "/chaos-run";
const STUB_URL = process.env.CHAOS_STUB_URL || "http://chaos-stub:8000";

// The app's real modules (mounted into the container by docker-compose.chaos.yml).
const pool = require("/backend/src/db/pool");
const redis = require("/backend/src/services/redis");

// ---------------------------------------------------------------------------
// Logging + assertions
// ---------------------------------------------------------------------------

function log(...args) {
  console.log("[chaos]", ...args);
}

function assert(cond, msg) {
  if (!cond) {
    throw new Error(`ASSERT FAILED: ${msg}`);
  }
  log(`✔ ${msg}`);
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll until Redis accepts commands (the client connects asynchronously via
 * ioredis lazyConnect, so the first get/set can race the connection).
 */
async function waitForRedis(timeoutMs = 30000) {
  await waitFor(async () => {
    const c = redis.getClient();
    const pong = await c.ping();
    return pong === "PONG";
  }, { timeoutMs, intervalMs: 500, label: "Redis to accept commands" });
}

async function waitFor(fn, { timeoutMs = 30000, intervalMs = 500, label = "condition" } = {}) {
  const start = Date.now();
  let lastErr = null;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${label}${lastErr ? ` (last error: ${lastErr.message})` : ""}`);
}

// ---------------------------------------------------------------------------
// Marker-file protocol (host-side fault injection for Redis / Postgres)
// ---------------------------------------------------------------------------

function markerPath(name) {
  return path.join(RUN_DIR, `${name}.marker`);
}

function writeMarker(name) {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  fs.writeFileSync(markerPath(name), String(Date.now()));
  log(`marker written: ${name}`);
}

async function waitForMarker(name, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(markerPath(name))) {
      log(`marker observed: ${name}`);
      return;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for marker: ${name}`);
}

// ---------------------------------------------------------------------------
// Chaos-stub fault injection (Horizon / Soroban RPC)
// ---------------------------------------------------------------------------

async function setFault(target, mode, durationMs) {
  const res = await fetch(`${STUB_URL}/__chaos/fault`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, mode, durationMs }),
  });
  if (!res.ok) throw new Error(`setFault(${target}, ${mode}) failed: HTTP ${res.status}`);
  log(`fault set: ${target} → ${mode}${durationMs ? ` (${durationMs}ms)` : ""}`);
}

async function clearFault(target) {
  return setFault(target, "ok");
}

async function stubStats() {
  const res = await fetch(`${STUB_URL}/__chaos/stats`);
  if (!res.ok) throw new Error(`stub stats failed: HTTP ${res.status}`);
  return (await res.json()).stats;
}

// ---------------------------------------------------------------------------
// DB helpers (through the app's real pool)
// ---------------------------------------------------------------------------

async function resetDb() {
  await pool.query(
    "TRUNCATE donations, projects, recurring_donations, idempotency_keys RESTART IDENTITY CASCADE",
  );
  log("database reset");
}

async function seedProject(projectId, { name = "Chaos Test Project" } = {}) {
  await pool.query(
    `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm, raised_xlm, donor_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [projectId, name, "Chaos suite project", "Reforestation", "Brazil", makePublicKey("Z"), "50000", "0", 0],
  );
}

async function countDonations(projectId) {
  const r = await pool.query("SELECT COUNT(*)::int AS n FROM donations WHERE project_id = $1", [projectId]);
  return r.rows[0].n;
}

async function projectRaised(projectId) {
  const r = await pool.query("SELECT raised_xlm FROM projects WHERE id = $1", [projectId]);
  return r.rows.length ? parseFloat(r.rows[0].raised_xlm) : null;
}

async function seedRecurringSchedule({ recurringId = 7, donorAddress, projectId, amount = "10", nextExecutionAt = new Date(Date.now() - 60_000) }) {
  await pool.query(
    `INSERT INTO recurring_donations (donor_address, recurring_id, project_id, amount, currency, interval_seconds, next_execution_at, active)
     VALUES ($1, $2, $3, $4, 'XLM', 604800, $5, TRUE)`,
    [donorAddress, recurringId, projectId, amount, nextExecutionAt],
  );
}

async function getSchedule(recurringId) {
  const r = await pool.query("SELECT * FROM recurring_donations WHERE recurring_id = $1", [recurringId]);
  return r.rows[0] || null;
}

// ---------------------------------------------------------------------------
// recordDonation invocation shim (mirrors donations.integration.test.js)
// ---------------------------------------------------------------------------

async function invokeRecordDonation(recordDonation, body) {
  const req = {
    body,
    headers: {},
    app: { get: () => null },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  const next = (err) => {
    if (err) {
      res.status(err.status || 500).json({ error: err.message });
      throw err;
    }
  };
  await recordDonation(req, res, next);
  return res;
}

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

function makePublicKey(char = "A") {
  return `G${String(char).repeat(55)}`;
}

const TX_HEX = "0123456789abcdef";

/**
 * Build a 64-char hex tx hash. `seed` may be a hex character or a number
 * (mapped into the hex alphabet via modulo).
 */
function makeTxHash(seed = "a") {
  const char =
    typeof seed === "number"
      ? TX_HEX[seed % TX_HEX.length]
      : TX_HEX.includes(String(seed)) ? String(seed) : "0";
  return char.repeat(64);
}

/**
 * Read the numeric value of a prom-client Counter/Gauge (v15 `get()` is
 * async and returns { values: [{ labels, value }] }).
 */
async function metricValue(metric) {
  const snapshot = await metric.get();
  return (snapshot.values || []).reduce((sum, v) => sum + (v.value || 0), 0);
}

module.exports = {
  RUN_DIR,
  STUB_URL,
  pool,
  redis,
  waitForRedis,
  log,
  assert,
  sleep,
  waitFor,
  writeMarker,
  waitForMarker,
  setFault,
  clearFault,
  stubStats,
  resetDb,
  seedProject,
  countDonations,
  projectRaised,
  seedRecurringSchedule,
  getSchedule,
  invokeRecordDonation,
  makePublicKey,
  makeTxHash,
  metricValue,
};
