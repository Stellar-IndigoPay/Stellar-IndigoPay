"use strict";

/**
 * txSubmitter.js
 *
 * Reliable Stellar transaction submission layer with:
 * - Fee estimation with fallback
 * - Retry classification (retryable vs terminal)
 * - Sequence management with bounded retry
 * - Idempotency (hash → result cache)
 * - Finality verification with configurable wait
 * - Prometheus metrics
 *
 * Usage:
 *   const { submitTransaction } = require('./txSubmitter');
 *   const result = await submitTransaction({
 *     signedXdr: '...',
 *     txHash: '...', // optional, for idempotency
 *     waitForFinality: true,
 *     maxRetries: 3,
 *   });
 */

const { Horizon, Networks, rpc, Transaction } = require("@stellar/stellar-sdk");
const { CircuitBreaker } = require("./circuitBreaker");
const logger = require("../logger");
const { Counter, Histogram, Gauge } = require("prom-client");
const { registry } = require("./metrics");

// ---------------------------------------------------------------------------
// Configuration
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
const NETWORK_PASSPHRASE = NETWORK_PASSPHRASES[NETWORK];

const server = new Horizon.Server(HORIZON_URL);
const rpcServer = new rpc.Server(RPC_URL);

const DEFAULT_MAX_RETRIES = Number(process.env.TX_SUBMITTER_MAX_RETRIES || 5);
const DEFAULT_BASE_DELAY_MS = Number(process.env.TX_SUBMITTER_BASE_DELAY_MS || 200);
const DEFAULT_FINALITY_TIMEOUT_MS = Number(process.env.TX_SUBMITTER_FINALITY_TIMEOUT_MS || 30000);
const DEFAULT_FINALITY_CHECK_INTERVAL_MS = Number(process.env.TX_SUBMITTER_FINALITY_INTERVAL_MS || 2000);

// Fee estimation
const DEFAULT_BASE_FEE = 100;
const FEE_MULTIPLIER = 1.2; // 20% buffer
const MAX_FEE_MULTIPLIER = 5.0;

// ---------------------------------------------------------------------------
// Prometheus Metrics
// ---------------------------------------------------------------------------

const submissionLatency = new Histogram({
  name: "indigopay_tx_submission_latency_seconds",
  help: "Transaction submission latency in seconds",
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

const finalityWaitTime = new Histogram({
  name: "indigopay_tx_finality_wait_seconds",
  help: "Time to wait for transaction finality",
  buckets: [1, 5, 10, 15, 30, 60],
  registers: [registry],
});

const retryCounts = new Counter({
  name: "indigopay_tx_submission_retries_total",
  help: "Total retry attempts by error class",
  labelNames: ["error_class"],
  registers: [registry],
});

const submissionStatus = new Counter({
  name: "indigopay_tx_submission_status_total",
  help: "Total submissions by final status",
  labelNames: ["status"],
  registers: [registry],
});

const terminalFailures = new Counter({
  name: "indigopay_tx_terminal_failures_total",
  help: "Total terminal failures",
  labelNames: ["error_code"],
  registers: [registry],
});

const cacheHitCounter = new Counter({
  name: "indigopay_tx_cache_hits_total",
  help: "Transaction cache hits",
  registers: [registry],
});

// ---------------------------------------------------------------------------
// In-memory result cache (transaction hash → result)
// ---------------------------------------------------------------------------

const txResultCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// Periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of txResultCache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      txResultCache.delete(key);
    }
  }
}, 60 * 1000);

function getCachedResult(txHash) {
  const entry = txResultCache.get(txHash);
  if (entry) {
    cacheHitCounter.inc();
    return entry.result;
  }
  return null;
}

function setCachedResult(txHash, result) {
  txResultCache.set(txHash, { result, timestamp: Date.now() });
}

// ---------------------------------------------------------------------------
// Error Classification
// ---------------------------------------------------------------------------

const RETRYABLE_ERRORS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /503/i,
  /502/i,
  /504/i,
  /429/i, // Rate limit
  /too many requests/i,
  /timeout/i,
  /connection refused/i,
];

const TERMINAL_ERRORS = [
  /bad sequence/i,
  /tx_bad_seq/i,
  /insufficient fee/i,
  /insufficient balance/i,
  /bad auth/i,
  /invalid signature/i,
  /tx_bad_auth/i,
  /too early/i,
  /too late/i,
];

function classifyError(err) {
  const message = (err && err.message) || String(err);

  // Check terminal errors first
  for (const pattern of TERMINAL_ERRORS) {
    if (pattern.test(message)) {
      return { type: "terminal", code: "terminal_error" };
    }
  }

  // Check retryable errors
  for (const pattern of RETRYABLE_ERRORS) {
    if (pattern.test(message)) {
      return { type: "retryable", code: "retryable_error" };
    }
  }

  // Unknown errors: safe to retry once, but don't hammer
  return { type: "unknown", code: "unknown_error" };
}

function isRetryable(err) {
  return classifyError(err).type !== "terminal";
}

// ---------------------------------------------------------------------------
// Fee Estimation
// ---------------------------------------------------------------------------

async function estimateFee(env = {}) {
  const { baseFee = DEFAULT_BASE_FEE } = env;

  try {
    // Try to get fee from RPC
    const feeStats = await server.feeStats();
    const p10Fee = parseInt(feeStats.fee_charged.p10, 10) || baseFee;
    const p50Fee = parseInt(feeStats.fee_charged.p50, 10) || baseFee;
    const p90Fee = parseInt(feeStats.fee_charged.p90, 10) || baseFee;

    // Use p90 with 20% buffer, but cap at 5x base
    let recommended = Math.ceil(p90Fee * FEE_MULTIPLIER);
    const maxFee = baseFee * MAX_FEE_MULTIPLIER;
    recommended = Math.min(recommended, maxFee);
    recommended = Math.max(recommended, baseFee);

    logger.debug({
      event: "fee_estimation",
      p10: p10Fee,
      p50: p50Fee,
      p90: p90Fee,
      recommended,
      baseFee,
    }, "Fee estimation completed");

    return recommended;
  } catch (err) {
    logger.warn({
      event: "fee_estimation_fallback",
      err: err.message,
    }, "Fee estimation failed, using base fee");
    return baseFee;
  }
}

// ---------------------------------------------------------------------------
// Sequence Management
// ---------------------------------------------------------------------------

async function fetchSequence(accountId, retries = 3) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const account = await server.loadAccount(accountId);
      return {
        sequence: parseInt(account.sequence, 10),
        sequenceStr: account.sequence,
      };
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        await new Promise(r => setTimeout(r, 200 * (attempt + 1)));
      }
    }
  }
  throw new Error(`Failed to fetch sequence after ${retries} attempts: ${lastError.message}`);
}

async function fetchAndReserveSequence(accountId, options = {}) {
  const { maxRetries = 3 } = options;
  const result = await fetchSequence(accountId, maxRetries);
  // Note: Actual reservation would involve building a tx with that sequence
  // This is handled by the caller when building the transaction
  return result;
}

// ---------------------------------------------------------------------------
// Finality Verification
// ---------------------------------------------------------------------------

async function verifyFinality(
  txHash,
  options = {}
) {
  const {
    timeoutMs = DEFAULT_FINALITY_TIMEOUT_MS,
    checkIntervalMs = DEFAULT_FINALITY_CHECK_INTERVAL_MS,
  } = options;

  const startTime = Date.now();

  let lastError = null;
  while (Date.now() - startTime < timeoutMs) {
    try {
      const tx = await server.transactions().transaction(txHash).call();
      submissionStatus.inc({ status: "confirmed" });
      finalityWaitTime.observe((Date.now() - startTime) / 1000);
      return {
        confirmed: true,
        transaction: tx,
        waitTimeMs: Date.now() - startTime,
      };
    } catch (err) {
      lastError = err;
      if (err.response && err.response.status === 404) {
        // Not found yet, wait and retry
        await new Promise(r => setTimeout(r, checkIntervalMs));
        continue;
      }
      // Other error - retry
      await new Promise(r => setTimeout(r, checkIntervalMs));
    }
  }

  // Timeout reached
  submissionStatus.inc({ status: "unconfirmed" });
  return {
    confirmed: false,
    error: lastError,
    waitTimeMs: Date.now() - startTime,
    message: `Transaction ${txHash} not confirmed within ${timeoutMs}ms`,
  };
}

// ---------------------------------------------------------------------------
// Main Submission Function
// ---------------------------------------------------------------------------

async function submitTransaction({
  signedXdr,
  txHash,
  waitForFinality = true,
  maxRetries = DEFAULT_MAX_RETRIES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  finalityTimeoutMs = DEFAULT_FINALITY_TIMEOUT_MS,
  feeOptions = {},
}) {
  const startTime = Date.now();
  let lastError = null;
  let finalResult = null;

  // Validate input
  if (!signedXdr) {
    throw new Error("signedXdr is required");
  }

  // Compute hash if not provided (or use provided)
  const hash = txHash || computeTxHash(signedXdr);

  // Check cache first (idempotency)
  const cached = getCachedResult(hash);
  if (cached) {
    logger.info({
      event: "tx_submission_cache_hit",
      txHash: hash,
    }, "Transaction result found in cache");
    return {
      ...cached,
      fromCache: true,
    };
  }

  // Estimate fee
  let fee = DEFAULT_BASE_FEE;
  try {
    fee = await estimateFee(feeOptions);
    logger.debug({
      event: "tx_submission_fee",
      fee,
    }, "Using estimated fee");
  } catch (err) {
    logger.warn({
      event: "tx_submission_fee_fallback",
      err: err.message,
    }, "Using fallback fee");
  }

  // Attempt submission with retry
  let attempt = 0;
  let finalityResult = null;

  while (attempt <= maxRetries) {
    attempt++;
    try {
      // Submit the transaction
      const submitResult = await submitWithCircuitBreaker(signedXdr);

      finalResult = {
        success: true,
        status: submitResult.status,
        txHash: hash,
        attempt,
        submittedAt: new Date().toISOString(),
      };

      // Cache the result
      setCachedResult(hash, finalResult);

      // If wait for finality is requested
      if (waitForFinality) {
        finalityResult = await verifyFinality(hash, {
          timeoutMs: finalityTimeoutMs,
        });
        finalResult.finality = finalityResult;
        finalResult.confirmed = finalityResult.confirmed;
      } else {
        finalResult.confirmed = false;
      }

      // Record latency
      submissionLatency.observe((Date.now() - startTime) / 1000);
      submissionStatus.inc({ status: finalResult.confirmed ? "confirmed" : "submitted" });

      return finalResult;
    } catch (err) {
      lastError = err;
      const classification = classifyError(err);

      // Log the error
      logger.warn({
        event: "tx_submission_attempt_failed",
        attempt,
        maxRetries,
        errorClass: classification.type,
        errorCode: classification.code,
        txHash: hash,
        err: err.message,
      }, `Submission attempt ${attempt}/${maxRetries + 1} failed`);

      // Handle terminal errors
      if (classification.type === "terminal") {
        terminalFailures.inc({ error_code: classification.code });
        submissionStatus.inc({ status: "terminal_failed" });
        throw new Error(`Terminal failure: ${err.message}`);
      }

      // If this was the last attempt, throw
      if (attempt > maxRetries) {
        submissionStatus.inc({ status: "retry_exhausted" });
        throw new Error(`Failed after ${maxRetries + 1} attempts: ${err.message}`);
      }

      // Calculate delay with jitter
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 100,
        10000
      );

      retryCounts.inc({ error_class: classification.type });

      // Wait before retry
      await new Promise(r => setTimeout(r, delay));
    }
  }

  // Should never reach here, but just in case
  throw lastError || new Error("Submission failed with unknown error");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function submitWithCircuitBreaker(signedXdr) {
  const breaker = getCircuitBreaker();
  return breaker.call(async () => {
    const result = await rpcServer.sendTransaction(signedXdr);
    if (result.status === "ERROR") {
      throw new Error(`Transaction failed: ${result.errorResult || result.error}`);
    }
    return result;
  });
}

// Singleton circuit breaker
let _breaker = null;

function getCircuitBreaker() {
  if (!_breaker) {
    _breaker = new CircuitBreaker({
      name: "tx_submitter",
      failureThreshold: 5,
      resetTimeout: 30000,
    });
  }
  return _breaker;
}

function computeTxHash(signedXdr) {
  // Simple hash - in production you'd use a proper hash of the transaction
  // This is a placeholder - the actual hash is computed from the XDR
  try {
    const tx = Transaction.fromXDR(signedXdr, NETWORK_PASSPHRASE);
    return tx.hash().toString("hex");
  } catch (err) {
    // If we can't parse, use a hash of the XDR string
    const crypto = require("crypto");
    return crypto.createHash("sha256").update(signedXdr).digest("hex");
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

module.exports = {
  // Main functions
  submitTransaction,
  estimateFee,
  verifyFinality,
  fetchSequence,
  fetchAndReserveSequence,

  // Classification
  classifyError,
  isRetryable,

  // Cache management
  getCachedResult,
  setCachedResult,
  clearCache: () => txResultCache.clear(),

  // Metrics
  submissionLatency,
  finalityWaitTime,
  retryCounts,
  submissionStatus,
  terminalFailures,
  cacheHitCounter,

  // For testing
  _resetBreaker: () => { _breaker = null; },
};
