/**
 * test/chaos/stub/server.js
 *
 * Zero-dependency HTTP stub that impersonates the two Stellar endpoints the
 * backend talks to — Horizon (REST) and Soroban RPC (JSON-RPC) — so the
 * chaos suite can run fully offline against the REAL backend code paths
 * (donation recording, recurring keeper, retry/circuit-breaker wrappers).
 *
 * Fault injection (admin API, called by the chaos driver):
 *
 *   POST /__chaos/fault  { target: "horizon"|"soroban", mode: "ok"|"503"|"timeout", durationMs? }
 *
 *   - "503"    → every matching request answers HTTP 503 (retryable).
 *   - "timeout"→ every matching request is held for ~800ms and then fails
 *                with HTTP 503. A real TCP hang is indistinguishable from a
 *                dead peer to the client (axios/fetch have no short timeout),
 *                so a delayed failure response is the deterministic way to
 *                exercise the retry + backoff path without a 5-minute hang.
 *
 *   GET  /__chaos/fault   current fault state (debug)
 *   GET  /__chaos/stats   request counters per service, for assertions
 *   GET  /__chaos/health  liveness for the compose healthcheck
 *
 * Endpoints:
 *   GET  /horizon/transactions/:hash → { successful: true }       (donation tx verification)
 *   GET  /horizon/accounts/:id       → { account_id, sequence }   (keeper loadAccount)
 *   GET  /horizon/fee_stats          → { last_ledger, ... }       (readiness probe)
 *   POST /soroban                    → JSON-RPC (getLatestLedger, simulateTransaction,
 *                                                sendTransaction, getEvents, getHealth, …)
 */
"use strict";

const http = require("http");

const PORT = Number(process.env.PORT || 8000);
const TIMEOUT_DELAY_MS = 800;

/** Per-service fault state: { mode: "ok"|"503"|"timeout", until: number|null } */
const faults = { horizon: { mode: "ok", until: null }, soroban: { mode: "ok", until: null } };
const stats = { horizonRequests: 0, sorobanRequests: 0 };

function currentMode(target) {
  const f = faults[target];
  if (!f || f.mode === "ok") return "ok";
  if (f.until && Date.now() > f.until) return "ok";
  return f.mode;
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function handleFaultedTarget(target, res) {
  const mode = currentMode(target);
  if (mode === "503") {
    json(res, 503, { error: `chaos stub: simulated ${target} HTTP 503` });
    return true;
  }
  if (mode === "timeout") {
    // Hold the request open, then fail it. The client observes a slow,
    // transient failure (retryable), never a clean success.
    setTimeout(() => json(res, 503, { error: `chaos stub: simulated ${target} timeout` }), TIMEOUT_DELAY_MS);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Horizon emulation
// ---------------------------------------------------------------------------

function handleHorizon(req, res) {
  if (handleFaultedTarget("horizon", res)) return;

  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname; // e.g. /horizon/transactions/<hash>

  if (path.startsWith("/horizon/transactions/")) {
    // Stellar SDK's CallBuilder._parseRecord returns the record untouched when
    // it has no `_links`, so `{ successful: true }` is all the donation
    // recording path needs (recordDonation checks `onChainTx.successful`).
    return json(res, 200, { successful: true, hash: path.split("/").pop(), id: path.split("/").pop(), paging_token: "1" });
  }
  if (path.startsWith("/horizon/accounts/")) {
    const accountId = path.split("/").pop();
    // Minimal account record: AccountResponse only requires account_id + sequence.
    return json(res, 200, { account_id: accountId, sequence: "100" });
  }
  if (path === "/horizon/fee_stats") {
    return json(res, 200, { last_ledger: "1", last_ledger_base_fee: "100", fee_charged: { max: 100, min: 100, mode: 100, p10: 100, p20: 100, p30: 100, p40: 100, p50: 100, p60: 100, p70: 100, p80: 100, p90: 100, p95: 100, p99: 100 } });
  }
  // Any other Horizon endpoint: harmless empty record.
  return json(res, 200, {});
}

// ---------------------------------------------------------------------------
// Soroban RPC (JSON-RPC) emulation
// ---------------------------------------------------------------------------

function rpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function handleSoroban(req, res, rawBody) {
  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return json(res, 400, { error: "invalid JSON-RPC" });
  }
  stats.sorobanRequests += 1;

  if (handleFaultedTarget("soroban", res)) return;

  const id = body.id !== undefined ? body.id : 1;
  const method = body.method;

  switch (method) {
    case "getLatestLedger":
      return json(res, 200, rpcResult(id, { sequence: 1, hash: "0".repeat(64), protocolVersion: 22 }));
    case "getHealth":
      return json(res, 200, rpcResult(id, { status: "healthy" }));
    case "getNetwork":
      return json(res, 200, rpcResult(id, { passphrase: "Test SDF Network ; September 2015", friendbotUrl: "http://chaos-stub:8000/horizon/friendbot" }));
    case "simulateTransaction":
      // Minimal simulation success: SorobanDataBuilder("") yields an empty
      // (valid) SorobanTransactionData, and an empty `results` array is left
      // untouched by parseRawSimulation. Enough for withRetry/simulate calls
      // to resolve — which is what the resilience assertions exercise.
      return json(res, 200, rpcResult(id, {
        status: "SUCCESS",
        transactionData: "",
        minResourceFee: "0",
        results: [],
        events: [],
      }));
    case "sendTransaction":
      return json(res, 200, rpcResult(id, {
        status: "PENDING",
        hash: "a".repeat(64),
        latestLedger: "1",
        latestLedgerCloseTime: new Date().toISOString(),
      }));
    case "getEvents":
      return json(res, 200, rpcResult(id, { events: [], latestLedger: "1" }));
    default:
      return json(res, 200, rpcResult(id, {}));
  }
}

// ---------------------------------------------------------------------------
// Admin API (fault injection + observability)
// ---------------------------------------------------------------------------

function handleAdmin(req, res, rawBody) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname;

  if (path === "/__chaos/health") {
    return json(res, 200, { ok: true, uptimeSeconds: Math.floor(process.uptime()) });
  }

  if (path === "/__chaos/fault") {
    if (req.method === "POST") {
      let body;
      try {
        body = JSON.parse(rawBody);
      } catch {
        return json(res, 400, { error: "invalid fault config" });
      }
      const { target, mode, durationMs } = body;
      if (target !== "horizon" && target !== "soroban") {
        return json(res, 400, { error: `unknown fault target: ${target}` });
      }
      if (!["ok", "503", "timeout"].includes(mode)) {
        return json(res, 400, { error: `unknown fault mode: ${mode}` });
      }
      faults[target] = {
        mode,
        until: mode === "ok" ? null : durationMs ? Date.now() + durationMs : null,
      };
      return json(res, 200, { ok: true, target, mode, until: faults[target].until });
    }
    return json(res, 200, { faults });
  }

  if (path === "/__chaos/stats") {
    return json(res, 200, { stats });
  }

  return json(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 1e6) req.destroy();
  });
  req.on("end", () => {
    try {
      if (url.pathname.startsWith("/__chaos/")) {
        return handleAdmin(req, res, rawBody);
      }
      if (url.pathname.startsWith("/horizon/")) {
        stats.horizonRequests += 1;
        return handleHorizon(req, res);
      }
      if (url.pathname === "/soroban" && req.method === "POST") {
        return handleSoroban(req, res, rawBody);
      }
      return json(res, 404, { error: `no route for ${req.method} ${url.pathname}` });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
});

server.listen(PORT, () => {
  console.log(`[chaos-stub] listening on :${PORT} (horizon + soroban-rpc fault-injecting stub)`);
});

// Stop cleanly on SIGTERM (docker stop).
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
