/**
 * test/chaos/scenarios/04-soroban-timeout.js
 *
 * Scenario 04 — Soroban RPC timeout during on-chain submission.
 *
 * Fault: the chaos-stub holds every Soroban RPC request for ~800ms and then
 * fails it with HTTP 503 — the deterministic stand-in for an RPC timeout
 * (a true TCP hang is indistinguishable from a dead peer to the client, so
 * a delayed failure is what actually exercises the retry path).
 *
 * Assertions:
 *   - The real `withRetry` wrapper retries the transient failure with
 *     exponential backoff (sorobanRpcRetriesTotal increments).
 *   - Sustained timeouts trip the shared circuit breaker; while OPEN, calls
 *     fail fast instead of hammering the endpoint.
 *   - After the fault clears, the same call succeeds (eventual success) and
 *     the breaker returns to CLOSED.
 *
 * Fully self-contained: no host-side fault injection required.
 */
"use strict";

const h = require("../lib/harness");

async function run() {
  const { rpc } = require("@stellar/stellar-sdk");

  const stellar = require("/backend/src/services/stellar");
  const { withRetry, rpcBreaker, sorobanRpcRetriesTotal } = stellar;

  // Pull the breaker's real reset timeout from the app config so the test
  // never drifts from backend/src/services/stellar.js if it changes.
  const BREAKER_RESET_TIMEOUT_MS = rpcBreaker.resetTimeout;
  const BREAKER_RECOVERY_WAIT_MS = BREAKER_RESET_TIMEOUT_MS + 15000;
  const stubRpc = new rpc.Server(`${h.STUB_URL}/soroban`, { allowHttp: true });

  h.log("=== Scenario 04: Soroban RPC timeout — retry + circuit breaker + eventual success ===");

  // Sanity: healthy call resolves.
  const healthy = await withRetry(() => stubRpc.getLatestLedger());
  h.assert(healthy && typeof healthy.sequence === "number", "healthy Soroban RPC call resolves");
  h.assert(rpcBreaker.getState() === "closed", "breaker CLOSED at scenario start");

  // ── Inject timeout fault ─────────────────────────────────────────────────
  await h.setFault("soroban", "timeout");

  // ── Retry + backoff under timeout, then breaker opens ────────────────────
  const retriesBefore = await h.metricValue(sorobanRpcRetriesTotal);
  let attempts = 0;
  for (; attempts < 8; attempts++) {
    try {
      await withRetry(() => stubRpc.getLatestLedger());
    } catch {
      // expected while faulted
    }
    if (rpcBreaker.getState() === "open") break;
  }
  h.assert(rpcBreaker.getState() === "open", `circuit breaker OPEN after sustained RPC timeouts (${attempts + 1} attempt(s))`);
  const retriesAfter = await h.metricValue(sorobanRpcRetriesTotal);
  h.assert(
    retriesAfter > retriesBefore,
    `transient RPC failures retried with backoff (retries total ${retriesBefore} → ${retriesAfter})`,
  );

  // While OPEN the breaker rejects immediately (fast fail, no hammering).
  const fastFailStart = Date.now();
  let fastFailed = false;
  try {
    await withRetry(() => stubRpc.getLatestLedger());
  } catch (err) {
    fastFailed = /Circuit breaker/.test(err.message);
  }
  h.assert(fastFailed, "calls fail fast while breaker is OPEN (rejected without hitting the RPC)");
  h.assert(Date.now() - fastFailStart < 5000, `fast-fail rejection is immediate (<5s, took ${Date.now() - fastFailStart}ms)`);

  // ── Recovery: eventual success + breaker closes ──────────────────────────
  await h.clearFault("soroban");

  await h.waitFor(async () => {
    try {
      const ledger = await withRetry(() => stubRpc.getLatestLedger());
      return ledger && typeof ledger.sequence === "number" && rpcBreaker.getState() === "closed";
    } catch {
      return false;
    }
  }, { timeoutMs: BREAKER_RECOVERY_WAIT_MS, intervalMs: 2000, label: "Soroban RPC call to succeed and breaker to close" });
  h.assert(rpcBreaker.getState() === "closed", "circuit breaker recovered to CLOSED after the RPC recovered");
  h.log("eventual success achieved: the same call that timed out now resolves");
}

module.exports = { run };
