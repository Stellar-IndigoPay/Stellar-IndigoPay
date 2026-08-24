"use strict";

/**
 * Configuration for the transaction submitter
 */

module.exports = {
  maxRetries: parseInt(process.env.TX_SUBMITTER_MAX_RETRIES || '5', 10),
  baseDelayMs: parseInt(process.env.TX_SUBMITTER_BASE_DELAY_MS || '200', 10),
  finalityTimeoutMs: parseInt(process.env.TX_SUBMITTER_FINALITY_TIMEOUT_MS || '30000', 10),
  finalityCheckIntervalMs: parseInt(process.env.TX_SUBMITTER_FINALITY_INTERVAL_MS || '2000', 10),
  cacheTTLMs: parseInt(process.env.TX_SUBMITTER_CACHE_TTL_MS || '3600000', 10),
  maxFeeMultiplier: parseFloat(process.env.TX_SUBMITTER_MAX_FEE_MULTIPLIER || '5.0'),
  feeMultiplier: parseFloat(process.env.TX_SUBMITTER_FEE_MULTIPLIER || '1.2'),
  defaultBaseFee: parseInt(process.env.TX_SUBMITTER_DEFAULT_BASE_FEE || '100', 10),
};
