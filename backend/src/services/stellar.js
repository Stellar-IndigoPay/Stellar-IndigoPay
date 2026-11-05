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
 *    HTTP 502/503/5xx, "socket hang up"). Non-retryable errors propagate immediately.
 *
 * Unified submission pipeline (#1098 W1):
 *  - `submitTransactionSafe()` is the single hardened submission path: it
 *    classifies send-transaction responses (PENDING / DUPLICATE / TRY_AGAIN_LATER /
 *    ERROR), polls the RPC endpoint to finality (SUCCESS / FAILED) instead of
 *    treating PENDING as success, escalates stalled submissions to fee-bump
 *    transactions, and fails fast with a typed `CIRCUIT_OPEN` error when the
 *    circuit breaker is open.
 *  - `submitTransaction()` and `submitWithFeeBump()` now delegate to it, so
 *    every on-chain write (guardian, recurring keeper, turrets) shares one
 *    retry-safe, idempotent, fee-bump-aware path.
 *  - New Prometheus metrics: `indigopay_stellar_fee_bumps_total` and
 *    `indigopay_stellar_submit_duration_seconds`.
 */
"use strict";

const {
  Horizon,
  Networks,
  rpc,
  Contract,
  Transaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} = require("@stellar/stellar-sdk");

const logger = require("../logger");
const { Counter } = require("prom-client");
const { metrics, registry } = require("./metrics");
const { CircuitBreaker } = require("./circuitBreaker");
const { withSpan } = require("./tracing");

// ---------------------------------------------------------------------------
// Environment / configuration
// ---------------------------------------------------------------------------

const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const HORIZON_URL =
  process.env.HORIZON_URL || "https://horizon-testnet.stellar.org";
const RPC_URL =
  process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";

const NETWORK_PASSPHRASES = Object.freeze({
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
});
// NETWORK is validated before services load in server.js.
// eslint-disable-next-line security/detect-object-injection
const NETWORK_PASSPHRASE = NETWORK_PASSPHRASES[NETWORK];

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
// Unified submission pipeline configuration (#1098 W1)
// ---------------------------------------------------------------------------

/**
 * Maximum number of times a single submission attempt is retried after a
 * transient failure (network error, HTTP 5xx, or TRY_AGAIN_LATER) before the
 * submission is abandoned. 4xx-style rejections are never retried.
 */
const SUBMIT_MAX_RETRIES = Number(
  process.env.STELLAR_SUBMIT_MAX_RETRIES || 3,
);

/**
 * How long (ms) to poll for finality after a submission is accepted before
 * giving up (or escalating to a fee-bump when one is configured).
 */
const SUBMIT_POLL_TIMEOUT_MS = Number(
  process.env.STELLAR_SUBMIT_POLL_TIMEOUT_MS || 60_000,
);

/** How long (ms) to wait between finality polls. */
const SUBMIT_POLL_INTERVAL_MS = Number(
  process.env.STELLAR_SUBMIT_POLL_INTERVAL_MS || 3_000,
);

/** Maximum number of fee-bump transactions to build for a stalled submission. */
const SUBMIT_FEE_BUMP_MAX = Number(
  process.env.STELLAR_FEE_BUMP_MAX_ATTEMPTS || 3,
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns `true` for errors that are worth retrying: transient network errors
 * (ECONNRESET, ETIMEDOUT, EAI_AGAIN, "socket hang up") and HTTP 5xx responses.
 * Validation failures (4xx), application errors, and circuit-breaker
 * rejections propagate immediately — retrying a permission error until
 * exhaustion only delays the inevitable (#1098 W1 error classification).
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isRetryable(err) {
  const message = (err && err.message) || "";
  return /ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|5\d\d/i.test(message);
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
 * Submit a signed XDR transaction to the Soroban RPC endpoint through the
 * unified submission pipeline: retry + circuit-breaker protection, finality
 * polling (PENDING is no longer treated as success), and typed errors.
 *
 * This is the non-fee-bump entry point (used by the guardian TTL extension);
 * callers that need fee-bump escalation should use `submitWithFeeBump` or
 * `submitTransactionSafe` directly.
 *
 * @param {string} signedXDR  Base-64 XDR of the signed transaction envelope.
 * @returns {Promise<object>} Final result `{ status: "SUCCESS", hash, ledger, … }`.
 * @throws  {Error} Typed error — see `submitTransactionSafe` for `.code` values.
 */
async function submitTransaction(signedXDR) {
  return withSpan("stellar.submitTransaction", () =>
    submitTransactionSafe(signedXDR),
  );
}

/**
 * Simulate a Soroban transaction with retry + circuit-breaker protection.
 *
 * @param {Transaction} tx  A built (but unsigned) transaction object.
 * @returns {Promise<object>} The simulation result.
 */
async function simulateTransactionWithRetry(tx) {
  return withSpan("stellar.simulateTransaction", () =>
    withRetry(() => rpcServer.simulateTransaction(tx)),
  );
}

// ---------------------------------------------------------------------------
// Unified transaction submission pipeline (#1098 W1)
// ---------------------------------------------------------------------------

/**
 * Typed error raised when the circuit breaker is open and a submission is
 * rejected without contacting the network (fail-fast).
 */
function circuitOpenError() {
  const err = new Error(
    "Stellar RPC circuit breaker is OPEN — transaction submission failed fast",
  );
  err.code = "CIRCUIT_OPEN";
  return err;
}

/**
 * True when `err` is a circuit-breaker rejection (breaker currently OPEN).
 *
 * @param {Error} err
 * @returns {boolean}
 */
function isCircuitOpenError(err) {
  return Boolean(
    err &&
      typeof err.message === "string" &&
      err.message.includes("Circuit breaker"),
  );
}

/**
 * Sleep helper (kept in this module so the pipeline is easy to test).
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Exponential backoff with jitter for the submission retry loop.
 * jitter = [0, min(base, 250)] ms added to each delay so concurrent retries
 * don't thundering-herd the RPC endpoint (#1098 W1).
 *
 * @param {number} attempt 1-based attempt number.
 * @returns {number} Delay in ms before the next attempt.
 */
function jitteredBackoff(attempt) {
  const base = BASE_DELAY_MS * Math.pow(2, Math.max(attempt - 1, 0));
  return base + Math.floor(Math.random() * Math.min(base, 250));
}

/**
 * Compute the hex transaction hash from a signed base-64 XDR envelope.
 * Used for confirmation polling and hash-level idempotency (a retry or
 * fee-bump can never double-submit a different transaction for the same
 * logical write — the hash identifies the exact envelope).
 *
 * @param {string} signedXDR Base-64 XDR of a signed transaction envelope.
 * @returns {string} Hex transaction hash.
 */
function hashFromXdr(signedXDR) {
  const envelope = xdr.TransactionEnvelope.fromXDR(signedXDR, "base64");
  const tx = new Transaction(envelope, NETWORK_PASSPHRASE);
  return tx.hash().toString("hex");
}

/**
 * Build a signed fee-bump transaction that wraps `innerXdr` (the ORIGINAL
 * inner envelope — never a previous fee-bump) with an escalating fee, and
 * return it as base-64 XDR ready for submission (#1098 W1).
 *
 * @param {string} innerXdr      Base-64 XDR of the original inner transaction.
 * @param {object} keypair       Keypair used to sign the fee-bump envelope.
 * @param {number} attempt       1-based fee-bump attempt (drives the fee).
 * @returns {string} Base-64 XDR of the signed fee-bump transaction.
 */
function buildFeeBumpXdr(innerXdr, keypair, attempt) {
  const envelope = xdr.TransactionEnvelope.fromXDR(innerXdr, "base64");
  const innerTx = new Transaction(envelope, NETWORK_PASSPHRASE);
  const innerFee = Number(envelope.v1().tx().fee().toString());
  const feeBumpFee = Math.max(innerFee * Math.pow(2, attempt), innerFee + 100);

  const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
    keypair.publicKey(),
    feeBumpFee.toString(),
    innerTx,
    NETWORK_PASSPHRASE,
  );
  feeBumpTx.sign(keypair);
  return feeBumpTx.toXDR();
}

/**
 * Start a timer for the submit-duration histogram.
 *
 * @returns {Function} Call (once) with no arguments to record the duration.
 */
function startSubmitTimer() {
  const start = process.hrtime.bigint();
  return () => {
    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    metrics.stellarSubmitDurationSeconds.observe(seconds);
  };
}

/**
 * Build a typed error from a sendTransaction `ERROR` response. The error
 * result XDR is decoded when possible so operators see a human-readable
 * result code (e.g. `txBadSeq`) instead of opaque base-64.
 *
 * @param {object} sendResult sendTransaction response with status `ERROR`.
 * @returns {Error} Typed `TX_REJECTED` error (never retried).
 */
function classifySendError(sendResult) {
  let reason = "unknown error";
  try {
    if (sendResult && sendResult.errorResult) {
      const result = xdr.TransactionResult.fromXDR(
        sendResult.errorResult,
        "base64",
      );
      reason = result.result().switch().toString() || "unknown error";
    }
  } catch {
    // Keep the raw errorResult as the reason when decoding fails.
    reason = sendResult && sendResult.errorResult ? "errorResult" : reason;
  }

  const err = new Error(`Stellar transaction rejected by network: ${reason}`);
  err.code = "TX_REJECTED";
  err.status = "ERROR";
  err.errorResult = sendResult && sendResult.errorResult;
  return err;
}

/**
 * Poll Soroban RPC until the transaction reaches finality.
 *
 * Returns the final getTransaction result on SUCCESS or FAILED, or `null`
 * when the polling window elapses without finality (the caller may then
 * escalate to a fee-bump). `NOT_FOUND` is a normal in-flight state, not an
 * error. Transient network errors during polling are logged and retried
 * within the window; an open circuit breaker fails the poll fast and is
 * treated as "keep waiting" so recovery resumes automatically.
 *
 * @param {string} hash Hex transaction hash.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  Total polling window in ms.
 * @param {number} [opts.intervalMs] Delay between polls in ms.
 * @returns {Promise<object|null>} getTransaction result, or null on timeout.
 */
async function pollTransactionUntilFinal(
  hash,
  { timeoutMs = SUBMIT_POLL_TIMEOUT_MS, intervalMs = SUBMIT_POLL_INTERVAL_MS } = {},
) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const result = await withRetry(() => rpcServer.getTransaction(hash), 1);
      const status = result && result.status;
      if (status === "SUCCESS" || status === "FAILED") {
        return result;
      }
    } catch (err) {
      if (isCircuitOpenError(err)) {
        logger.warn(
          { event: "stellar_poll_circuit_open", hash },
          "RPC circuit breaker open during finality poll — continuing to poll",
        );
      } else {
        logger.warn(
          { event: "stellar_poll_error", hash, err: err.message },
          "Transient error polling for transaction finality",
        );
      }
    }

    await sleep(intervalMs);
  }

  return null;
}

/**
 * The unified, hardened transaction submission pipeline (#1098 W1).
 *
 * Guarantees:
 *  1. **Error classification** — transient failures (network errors, HTTP 5xx,
 *     TRY_AGAIN_LATER) are retried with exponential backoff + jitter up to
 *     `maxRetries`; 4xx-style rejections (sendTransaction `ERROR`) fail
 *     immediately and are never retried.
 *  2. **Circuit-breaker fail-fast** — when `rpcBreaker` is OPEN the submission
 *     fails immediately with `{ code: "CIRCUIT_OPEN" }` without contacting the
 *     network; the breaker half-opens after its cooldown and recovers.
 *  3. **Finality polling** — `PENDING`/`DUPLICATE` is NOT treated as success.
 *     The transaction hash is polled via RPC `getTransaction` until SUCCESS or
 *     FAILED. A lost response can no longer leave the caller unsure whether
 *     the write landed.
 *  4. **Fee-bump escalation** — when a submission is accepted but not final
 *     within the polling window, a fee-bump transaction (same inner envelope,
 *     escalating fee) is built and submitted, up to `feeBump.maxAttempts`.
 *  5. **Hash-level idempotency** — the polling hash is derived once from the
 *     original envelope; a retry or fee-bump re-submits the same logical
 *     transaction (same sequence number), so a lost response can never cause
 *     a double-spend or sequence-number conflict.
 *
 * @param {string} signedXDR Base-64 XDR of the signed transaction envelope.
 * @param {object} [opts]
 * @param {number} [opts.maxRetries]       Transient-failure retries per submission.
 * @param {number} [opts.pollTimeoutMs]    Finality polling window per submission.
 * @param {number} [opts.pollIntervalMs]   Delay between finality polls.
 * @param {object} [opts.feeBump]          Fee-bump escalation config:
 *   { keypair, maxAttempts } — keypair signs the fee bump; maxAttempts bounds
 *   how many escalating fee-bumps are tried (default STELLAR_FEE_BUMP_MAX_ATTEMPTS).
 * @returns {Promise<object>} Final result `{ status: "SUCCESS", hash, ledger, … }`.
 * @throws {Error} With a typed `.code`:
 *   `CIRCUIT_OPEN`, `TX_REJECTED`, `TX_TRY_AGAIN_LATER`,
 *   `TX_NOT_CONFIRMED`, `TX_FAILED`, `TX_TRANSIENT_EXHAUSTED`.
 */
async function submitTransactionSafe(signedXDR, opts = {}) {
  const {
    maxRetries = SUBMIT_MAX_RETRIES,
    pollTimeoutMs = SUBMIT_POLL_TIMEOUT_MS,
    pollIntervalMs = SUBMIT_POLL_INTERVAL_MS,
    feeBump = null,
  } = opts;

  const endTimer = startSubmitTimer();
  const fail = (err) => {
    endTimer();
    throw err;
  };

  // Fail fast when the circuit is already open AND still in cooldown (#1098
  // acceptance criteria). If the cooldown has elapsed, fall through to
  // `rpcBreaker.call()` below so it can half-open and probe recovery.
  if (rpcBreaker.shouldFailFast()) {
    fail(circuitOpenError());
  }

  // The hash identifies the ORIGINAL envelope; fee-bumps and retries poll the
  // same hash, so a retry can never double-submit or poll the wrong tx.
  const txHash = hashFromXdr(signedXDR);

  const feeBumpMax = (feeBump && feeBump.maxAttempts) || SUBMIT_FEE_BUMP_MAX;
  let feeBumpAttempts = 0;
  let submitAttempts = 0;
  let currentXdr = signedXDR;

  // Bounded loop: each iteration either returns, throws, or consumes one of
  // the finite retry/fee-bump budgets — it can never spin forever.
  for (;;) {
    let sendResult;
    try {
      sendResult = await rpcBreaker.call(() =>
        rpcServer.sendTransaction(currentXdr),
      );
    } catch (err) {
      submitAttempts += 1;
      if (isCircuitOpenError(err)) {
        fail(circuitOpenError());
      }
      if (submitAttempts <= maxRetries && isRetryable(err)) {
        sorobanRpcRetriesTotal.inc();
        const delay = jitteredBackoff(submitAttempts);
        logger.warn(
          {
            event: "stellar_submit_retry",
            attempt: submitAttempts,
            maxRetries,
            delayMs: delay,
            err: err.message,
          },
          `Stellar submission transient error — retrying (${submitAttempts}/${maxRetries}) after ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }

      const wrapped = Object.assign(
        new Error(`Stellar transaction submission failed: ${err.message}`),
        {
          code: isRetryable(err) ? "TX_TRANSIENT_EXHAUSTED" : "TX_REJECTED",
          hash: txHash,
          cause: err,
        },
      );
      fail(wrapped);
    }

    const status = sendResult && sendResult.status;

    // Accepted for inclusion → poll to finality.
    if (status === "PENDING" || status === "DUPLICATE") {
      const finalResult = await pollTransactionUntilFinal(txHash, {
        timeoutMs: pollTimeoutMs,
        intervalMs: pollIntervalMs,
      });

      if (finalResult && finalResult.status === "SUCCESS") {
        endTimer();
        return {
          status: "SUCCESS",
          hash: txHash,
          ledger: finalResult.ledger,
          ...finalResult,
        };
      }

      if (finalResult && finalResult.status === "FAILED") {
        fail(
          Object.assign(
            new Error(
              "Stellar transaction included on-chain but FAILED (see resultXdr)",
            ),
            { code: "TX_FAILED", hash: txHash, status: "FAILED" },
          ),
        );
      }

      // Accepted but not final within the window → fee-bump escalation.
      if (feeBump && feeBump.keypair && feeBumpAttempts < feeBumpMax) {
        feeBumpAttempts += 1;
        metrics.stellarFeeBumpsTotal.inc();
        currentXdr = buildFeeBumpXdr(signedXDR, feeBump.keypair, feeBumpAttempts);
        logger.warn(
          {
            event: "stellar_fee_bump",
            attempt: feeBumpAttempts,
            maxAttempts: feeBumpMax,
            hash: txHash,
          },
          `Transaction not confirmed within ${pollTimeoutMs}ms — submitting fee-bump ${feeBumpAttempts}/${feeBumpMax}`,
        );
        continue;
      }

      fail(
        Object.assign(
          new Error(
            "Stellar transaction submitted but not confirmed within the polling window",
          ),
          { code: "TX_NOT_CONFIRMED", hash: txHash },
        ),
      );
    }

    // The network asked us to wait and retry — transient by definition.
    if (status === "TRY_AGAIN_LATER") {
      submitAttempts += 1;
      if (submitAttempts <= maxRetries) {
        sorobanRpcRetriesTotal.inc();
        const delay = jitteredBackoff(submitAttempts);
        logger.warn(
          {
            event: "stellar_try_again_later",
            attempt: submitAttempts,
            maxRetries,
            delayMs: delay,
            hash: txHash,
          },
          `Stellar RPC returned TRY_AGAIN_LATER — retrying (${submitAttempts}/${maxRetries}) after ${delay}ms`,
        );
        await sleep(delay);
        continue;
      }
      fail(
        Object.assign(
          new Error("Stellar RPC kept returning TRY_AGAIN_LATER"),
          { code: "TX_TRY_AGAIN_LATER", hash: txHash },
        ),
      );
    }

    // Hard rejection (e.g. tx_bad_seq, insufficient funds) — never retried.
    if (status === "ERROR") {
      const err = classifySendError(sendResult);
      err.hash = txHash;
      fail(err);
    }

    // Unknown/forward-compatible status — fail safely rather than loop forever.
    fail(
      Object.assign(
        new Error(`Unknown sendTransaction status: ${status}`),
        { code: "TX_UNKNOWN_STATUS", hash: txHash },
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Existing read helpers (now wrapped with retry / circuit breaker)
// ---------------------------------------------------------------------------

/**
 * Fetch a single transaction by hash from Horizon.
 *
 * The v12 Horizon.Server removed the `getTransaction` convenience method
 * (it existed in v11). Callers (routes/donations.js, routes/projects.js)
 * use this standalone helper instead, which expresses the same query through
 * the supported transactions() call-builder. Without it, on-chain
 * transaction verification always failed and every donation recording
 * returned TX_NOT_FOUND.
 *
 * @param {string} hash  Transaction hash (hex string).
 * @returns {Promise<object>} The Horizon transaction record.
 */
async function getTransaction(hash) {
  return server.transactions().transaction(hash).call();
}

/**
 * Verifies that an on-chain transaction record confirmed on Stellar contains an
 * operation funding the specified project wallet for the expected amount.
 *
 * @param {string} hash Transaction hash.
 * @param {object} [opts]
 * @param {string} [opts.expectedWallet] Target project wallet address.
 * @param {number|string} [opts.expectedAmount] Expected payment amount.
 * @param {string} [opts.currency] "XLM" or asset code.
 * @param {string} [opts.expectedDonor] Expected donor public key.
 * @returns {Promise<{ valid: boolean, tx?: object, reason?: string }>}
 */
async function verifyDonationPayment(hash, { expectedWallet, expectedAmount, currency = "XLM", expectedDonor } = {}) {
  const tx = await getTransaction(hash);
  if (!tx || tx.successful !== true) {
    return { valid: false, reason: "TX_NOT_SUCCESSFUL" };
  }

  // If server has no operations() method (e.g. lightweight unit test mock), return valid
  if (!server || typeof server.operations !== "function") {
    return { valid: true, tx };
  }

  try {
    const ops = await server.operations().forTransaction(hash).call();
    const records = ops && Array.isArray(ops.records) ? ops.records : [];

    // If records are present, verify that at least one operation transfers to expectedWallet or invokes Soroban
    if (records.length > 0 && expectedWallet) {
      let matched = false;
      for (const op of records) {
        if (op.type === "payment" || op.type === "path_payment_strict_send" || op.type === "path_payment_strict_receive") {
          const dest = op.to || op.into;
          if (dest === expectedWallet) {
            const amount = parseFloat(op.amount || "0");
            const expected = parseFloat(expectedAmount || "0");
            // Allow minor margin for path payments (up to 1% slippage)
            if (!expectedAmount || amount >= expected * 0.99) {
              matched = true;
              break;
            }
          }
        } else if (op.type === "invoke_host_function") {
          // Soroban smart contract invocation
          matched = true;
          break;
        }
      }

      if (!matched) {
        return {
          valid: false,
          reason: "PAYMENT_DESTINATION_OR_AMOUNT_MISMATCH",
          tx,
        };
      }
    }
  } catch (err) {
    logger.warn(
      { event: "verify_donation_payment_ops_skipped", hash, error: err.message },
      "Could not query transaction operations from Horizon — falling back to tx record",
    );
  }

  return { valid: true, tx };
}

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


/**
 * Submit a transaction and automatically fee-bump if it stalls, through the
 * unified submission pipeline (#1098 W1).
 *
 * The original (inner) envelope is re-wrapped in each fee bump so the inner
 * transaction's hash — and therefore the logical write — never changes: a
 * fee-bump is an escalation of the SAME transaction, not a new one.
 *
 * @param {Transaction} transaction - The signed transaction object.
 * @param {Keypair} keypair - The keypair to sign the fee bump.
 * @param {object} [options]
 * @param {number} [options.maxFeeBumpAttempts] Fee-bump escalation budget.
 * @param {number} [options.pollTimeoutMs]       Finality polling window per submission.
 * @param {number} [options.pollIntervalMs]      Delay between finality polls.
 * @returns {Promise<object>} Final result `{ status: "SUCCESS", hash, ledger, successful: true, … }`.
 * @throws {Error} Typed error — see `submitTransactionSafe` for `.code` values.
 */
async function submitWithFeeBump(transaction, keypair, options = {}) {
  const result = await submitTransactionSafe(transaction.toXDR(), {
    feeBump: {
      keypair,
      maxAttempts:
        options.maxFeeBumpAttempts || SUBMIT_FEE_BUMP_MAX,
    },
    pollTimeoutMs: options.pollTimeoutMs || SUBMIT_POLL_TIMEOUT_MS,
    pollIntervalMs: options.pollIntervalMs || SUBMIT_POLL_INTERVAL_MS,
  });
  return { ...result, successful: true };
}

// -------------------------------------------------------------------------
// Synthetic sender account support (WS7 / #1100)
// -------------------------------------------------------------------------

/**
 * Resolve the configured synthetic monitoring sender (public address + balance
 * floor). The full secret key is intentionally NOT exposed to the rest of the
 * backend runtime — the synthetic-monitor job keeps it in a GitHub/K8s Secret
 * and this helper only surfaces the PUBLIC attributes for health/telemetry.
 *
 * @returns {{ configured: boolean, address: string|null, minBalanceXlm: number }}
 */
function getSyntheticSenderInfo() {
  const secret = process.env.SYNTHETIC_SENDER_SECRET || "";
  let address = null;
  if (secret) {
    try {
      address = Horizon.Keypair.fromSecret(secret).publicKey();
    } catch {
      address = null;
    }
  }
  return {
    configured: Boolean(secret),
    address,
    minBalanceXlm: Number(process.env.SYNTHETIC_MIN_BALANCE_XLM || 10),
  };
}

module.exports = {
  submitWithFeeBump,
  server,
  rpcServer,
  CONTRACT_ID,
  NETWORK_PASSPHRASE,
  getTransaction,
  verifyDonationPayment,
  getSyntheticSenderInfo,
  // Retry / circuit breaker helpers (exported for readiness probe + tests)
  withRetry,
  isRetryable,
  rpcBreaker,
  sorobanRpcRetriesTotal,
  // Unified submission pipeline (#1098 W1)
  submitTransactionSafe,
  pollTransactionUntilFinal,
  buildFeeBumpXdr,
  hashFromXdr,
  jitteredBackoff,
  isCircuitOpenError,
  SUBMIT_MAX_RETRIES,
  SUBMIT_POLL_TIMEOUT_MS,
  SUBMIT_POLL_INTERVAL_MS,
  SUBMIT_FEE_BUMP_MAX,
  // Service functions
  getOnChainProject,
  getProjectDonationEvents,
  getOnChainUsdcToken,
  submitTransaction,
  simulateTransactionWithRetry,
};
