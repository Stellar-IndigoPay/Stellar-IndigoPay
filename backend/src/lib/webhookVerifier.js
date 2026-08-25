"use strict";

/**
 * lib/webhookVerifier.js
 *
 * Webhook signature verification utility for receivers.
 *
 * Supports multi-version verification (current, previous, next secrets) to handle
 * key rotation gracefully. Receivers can verify webhook signatures using their
 * known secret versions during the rotation window.
 *
 * Usage:
 *   const verifier = require('../lib/webhookVerifier');
 *   const isValid = verifier.verifyWebhookSignature(body, signatureHeader, secrets);
 */

const crypto = require("crypto");
const { verify, DEFAULT_REPLAY_WINDOW_SECONDS } = require("./webhookSign");

/**
 * Verify a webhook signature with multi-version secret support.
 *
 * @param {string} body raw request body that was signed
 * @param {string} signatureHeader value of X-Webhook-Signature header
 * @param {string[]} secrets array of secrets to try (current, previous, next)
 * @param {object} options optional configuration
 * @param {number} options.now current unix timestamp (defaults to Date.now())
 * @param {number} options.replayWindowSeconds replay window in seconds
 * @returns {boolean} true if signature is valid, false otherwise
 */
function verifyWebhookSignature(
  body,
  signatureHeader,
  secrets,
  options = {},
) {
  const now = options.now || Math.floor(Date.now() / 1000);
  const replayWindowSeconds =
    options.replayWindowSeconds || DEFAULT_REPLAY_WINDOW_SECONDS;

  return verify(body, secrets, signatureHeader, now, replayWindowSeconds);
}

/**
 * Extract key ID from signature header.
 *
 * @param {string} signatureHeader value of X-Webhook-Signature header
 * @returns {string|null} key ID or null if not found
 */
function extractKeyId(signatureHeader) {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return null;
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1
        ? [kv.trim(), ""]
        : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );

  return parts.kid || null;
}

/**
 * Extract timestamp from signature header.
 *
 * @param {string} signatureHeader value of X-Webhook-Signature header
 * @returns {number|null} unix timestamp or null if not found
 */
function extractTimestamp(signatureHeader) {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return null;
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1
        ? [kv.trim(), ""]
        : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );

  const t = Number.parseInt(parts.t, 10);
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse signature header into components.
 *
 * @param {string} signatureHeader value of X-Webhook-Signature header
 * @returns {{timestamp: number|null, keyId: string|null, signatures: string[]}}
 */
function parseSignatureHeader(signatureHeader) {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) {
    return { timestamp: null, keyId: null, signatures: [] };
  }

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1
        ? [kv.trim(), ""]
        : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );

  const timestamp = Number.isFinite(Number.parseInt(parts.t, 10))
    ? Number.parseInt(parts.t, 10)
    : null;

  const signatures = [];
  for (const [key, value] of Object.entries(parts)) {
    if (key.startsWith("v") && typeof value === "string" && value.length > 0) {
      signatures.push({ version: key, value });
    }
  }

  return {
    timestamp,
    keyId: parts.kid || null,
    signatures,
  };
}

module.exports = {
  verifyWebhookSignature,
  extractKeyId,
  extractTimestamp,
  parseSignatureHeader,
  DEFAULT_REPLAY_WINDOW_SECONDS,
};