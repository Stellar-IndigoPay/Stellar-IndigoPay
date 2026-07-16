/**
 * src/services/stellar.js
 *
 * Backend Stellar / Soroban service.
 *
 * Enhancements (GF-043):
 *  - `withRetry()` wraps every Soroban RPC call with exponential-backoff retry
 *    (default 3 retries, 100 ms base delay, doubles each attempt).
 *  - `rpcBreaker` is a CircuitBreaker that opens after 5 consecutive failures
 *    and resets after 30 s, preventing continued hammering of the RPC endpoint.
 *  - `sorobanRpcRetriesTotal` Prometheus Counter tracks total retry attempts.
 *  - Retry is only triggered for *transient* errors (ECONNRESET, ETIMEDOUT,
 *    HTTP 502/503, "socket hang up"). Non-retryable errors propagate immediately.
 */
"use strict";

const {
  Horizon,
  Networks,
  rpc,
  Contract,
  TransactionBuilder,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

const logger = require("../logger");
const { Counter } = require("prom-client");
const { registry } = require("./metrics");
const { CircuitBreaker } = require("./circuitBreaker");

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------

const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const HORIZON_URL =
  process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASE =
  NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;

const server = new Horizon.Server(HORIZON_URL);
const rpcServer = new rpc.Server(RPC_URL);
const CONTRACT_ID = process.env.CONTRACT_ID || "";

// ---------------------------------------------------------------------------
// Prometheus metrics
// ---------------------------------------------------------------------------

/**
 * Total number of Soroban RPC retry attempts (incremented once *per retry*,
 * not per initial attempt). Useful for alerting on flapping RPC endpoints.
 */
const sorobanRpcRetriesTotal = new Counter({
  name: "indigopay_soroban_rpc_retries_total",
  help: "Total Soroban RPC retry attempts due to transient errors",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// Circuit breaker + retry configuration
// ---------------------------------------------------------------------------

/** Shared circuit breaker for all Soroban RPC calls. */
const rpcBreaker = new CircuitBreaker({
  name: "soroban_rpc",
  failureThreshold: 5,
  resetTimeout: 30_000,
});

/** Maximum number of retries per RPC call (env-configurable). */
const MAX_RETRIES = Number(process.env.SOROBAN_RPC_MAX_RETRIES || 3);

/** Base delay for the first retry in milliseconds. Doubles on each attempt. */
const BASE_DELAY_MS = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` for errors that are worth retrying: transient network errors
 * and HTTP 502 / 503 gateway errors.  Validation failures (400), application
 * errors, and circuit-breaker rejections propagate immediately.
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryable(err) {
  const message = (err && err.message) || "";
  return /ECONNRESET|ETIMEDOUT|503|502|socket hang up/i.test(message);
}

/**
 * Execute `fn` with exponential-backoff retry, routed through `rpcBreaker`.
 *
 * Algorithm:
 *   attempt 0 → immediate
 *   attempt 1 → wait 100 ms
 *   attempt 2 → wait 200 ms
 *   attempt 3 → wait 400 ms
 *   …up to `maxRetries`
 *
 * The circuit breaker wraps every attempt.  If the breaker is OPEN the call
 * fails immediately without counting as a retry.
 *
 * @param {Function} fn           Async function to call.
 * @param {number}   [maxRetries] Override for MAX_RETRIES.
 * @returns {Promise<*>}
 */
async function withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await rpcBreaker.call(fn);
    } catch (err) {
      lastError = err;

      // Don't retry if the circuit is open — it's already managing recovery.
      const circuitOpen =
        err.message && err.message.includes("Circuit breaker");
      if (circuitOpen) {
        throw lastError;
      }

      if (attempt < maxRetries && isRetryable(err)) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt);
        logger.warn(
          {
            event: "soroban_rpc_retry",
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            err: err.message,
          },
          `Soroban RPC transient error — retrying (attempt ${attempt + 1}/${maxRetries}) after ${delay}ms`,
        );
        sorobanRpcRetriesTotal.inc();
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw lastError;
      }
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Soroban RPC wrappers
// ---------------------------------------------------------------------------

/**
 * Submit a signed XDR transaction to the Soroban RPC endpoint, with retry
 * and circuit-breaker protection.
 *
 * @param {string} signedXDR  Base-64 XDR of the signed transaction envelope.
 * @returns {Promise<object>} The RPC send-transaction response.
 * @throws  {Error} When the transaction status is `ERROR` or retries are exhausted.
 */
async function submitTransaction(signedXDR) {
  return withRetry(async () => {
    const result = await rpcServer.sendTransaction(signedXDR);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult}`);
    }
    return result;
  });
}

/**
 * Simulate a Soroban transaction with retry + circuit-breaker protection.
 *
 * @param {Transaction} tx  A built (but unsigned) transaction object.
 * @returns {Promise<object>} The simulation result.
 */
async function simulateTransactionWithRetry(tx) {
  return withRetry(() => rpcServer.simulateTransaction(tx));
}

// ---------------------------------------------------------------------------
// Existing read helpers (now wrapped with retry / circuit breaker)
// ---------------------------------------------------------------------------

async function getOnChainProject(projectId) {
  if (!CONTRACT_ID) return null;

  const contract = new Contract(CONTRACT_ID);
  const dummyAccount = new Horizon.Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "-1",
  );

  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_project", projectId))
    .setTimeout(30)
    .build();

  let result;
  try {
    result = await simulateTransactionWithRetry(tx);
  } catch {
    return null;
  }

  if (rpc.Api.isSimulationSuccess(result)) {
    return scValToNative(result.result.retval);
  }
  return null;
}

/**
 * Fetch donated events emitted by Soroban contract directly from Horizon/RPC event streaming API.
 * @param {string} projectId
 * @param {object} options
 * @returns {Promise<Array>}
 */
async function getProjectDonationEvents(
  projectId,
  { limit = 20, cursor } = {},
) {
  if (!CONTRACT_ID) return [];

  const pageSize = Math.min(Number.parseInt(limit, 10) || 20, 100);
  const request = {
    filters: [
      {
        type: "contract",
        contractIds: [CONTRACT_ID],
        topics: [
          [
            xdr.ScVal.scvSymbol("donated").toXDR("base64"),
            "*",
            xdr.ScVal.scvString(projectId).toXDR("base64"),
          ],
        ],
      },
    ],
    limit: pageSize,
  };
  if (cursor) {
    request.cursor = cursor;
  }

  let response;
  try {
    response = await withRetry(() => rpcServer.getEvents(request));
  } catch (err) {
    return [];
  }

  if (!response || !response.events) return [];

  return response.events
    .filter((evt) => {
      try {
        if (!evt.topic || evt.topic.length < 3) return false;
        const topic0 =
          typeof evt.topic[0] === "string"
            ? scValToNative(xdr.ScVal.fromXDR(evt.topic[0], "base64"))
            : scValToNative(evt.topic[0]);
        if (topic0 !== "donated") return false;
        const topic2 =
          typeof evt.topic[2] === "string"
            ? scValToNative(xdr.ScVal.fromXDR(evt.topic[2], "base64"))
            : scValToNative(evt.topic[2]);
        return topic2 === projectId;
      } catch {
        return true;
      }
    })
    .map((evt) => {
      let donor = "";
      try {
        if (evt.topic && evt.topic[1]) {
          if (typeof evt.topic[1] === "string") {
            try {
              donor = scValToNative(xdr.ScVal.fromXDR(evt.topic[1], "base64"));
            } catch {
              donor = evt.topic[1];
            }
          } else {
            donor = scValToNative(evt.topic[1]);
          }
        }
      } catch {
        // ignore
      }

      let amount = "0";
      let badge = "None";
      let msgHash = null;

      try {
        if (evt.value) {
          const valSc =
            typeof evt.value === "string"
              ? xdr.ScVal.fromXDR(evt.value, "base64")
              : evt.value;
          const decoded = scValToNative(valSc);
          if (Array.isArray(decoded)) {
            if (decoded[0] !== undefined && decoded[0] !== null) {
              amount = decoded[0].toString();
            }
            if (decoded[1] !== undefined && decoded[1] !== null) {
              if (
                decoded[1] === "USDC" ||
                (Array.isArray(decoded[1]) && decoded[1][0] === "USDC")
              ) {
                badge = "None";
              } else {
                const rawBadge = decoded[1];
                badge = Array.isArray(rawBadge)
                  ? rawBadge[0] || "None"
                  : rawBadge.toString();
              }
            }
            if (
              decoded.length > 2 &&
              decoded[2] !== undefined &&
              decoded[2] !== null
            ) {
              msgHash =
                typeof decoded[2] === "bigint"
                  ? Number(decoded[2])
                  : Number(decoded[2]);
              if (Number.isNaN(msgHash)) msgHash = decoded[2].toString();
            }
          } else if (decoded && typeof decoded === "object") {
            if (decoded.amount !== undefined && decoded.amount !== null)
              amount = decoded.amount.toString();
            if (decoded.badge !== undefined && decoded.badge !== null)
              badge = decoded.badge.toString();
            if (
              decoded.msgHash !== undefined ||
              decoded.msg_hash !== undefined
            ) {
              msgHash = decoded.msgHash ?? decoded.msg_hash;
            }
          }
        }
      } catch {
        // ignore
      }

      return {
        donor: donor || "",
        amount,
        ledger: evt.ledger || 0,
        badge,
        msgHash,
        pagingToken: evt.pagingToken || null,
      };
    });
}

/**
 * Resolve the USDC token address from the Soroban contract via
 * get_usdc_token(). Returns null when the contract is not configured
 * or the RPC call fails (non-fatal — caller should fall back to env var).
 *
 * @returns {Promise<string|null>}
 */
async function getOnChainUsdcToken() {
  if (!CONTRACT_ID) return null;

  const contract = new Contract(CONTRACT_ID);
  const dummyAccount = new Horizon.Account(
    "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    "-1",
  );

  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_usdc_token"))
    .setTimeout(30)
    .build();

  let result;
  try {
    result = await simulateTransactionWithRetry(tx);
  } catch {
    return null;
  }

  if (rpc.Api.isSimulationSuccess(result)) {
    return scValToNative(result.result.retval);
  }
  return null;
}

module.exports = {
  server,
  rpcServer,
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  // Retry / circuit breaker helpers (exported for readiness probe + tests)
  withRetry,
  isRetryable,
  rpcBreaker,
  sorobanRpcRetriesTotal,
  // Service functions
  getOnChainProject,
  getProjectDonationEvents,
  getOnChainUsdcToken,
  submitTransaction,
  simulateTransactionWithRetry,
};
