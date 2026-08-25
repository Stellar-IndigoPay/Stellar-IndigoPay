"use strict";

/**
 * lib/webhookSign.js
 *
 * Reusable helpers for signing webhook payloads in the GitHub style with
 * dual-version key rotation support:
 *
 *   X-Webhook-Id:        <uuid>
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: t=<unix>,kid=<key-id>,v1=<hex hmac-sha256>,v2=<hex hmac-sha256>
 *
 * Dual-version signing: payloads are signed with both the current and previous
 * secrets to allow receivers to update their keys without downtime. The kid
 * (key ID) header identifies which key version was used for the primary signature.
 *
 * Multi-version verification: receivers accept signatures from current, previous,
 * and next secrets (3-version window) to handle rotation gracefully.
 *
 * Receivers verify by recomputing HMAC over `t.<raw body>` using their known
 * secrets, then rejecting events whose timestamp is older than
 * REPLAY_WINDOW_SECONDS (default 5 minutes). This defends against
 * intercept-and-replay attacks and accidental duplicate deliveries.
 */

const crypto = require("crypto");

const DEFAULT_REPLAY_WINDOW_SECONDS = 5 * 60;
const GRACE_PERIOD_DAYS = 7;

/**
 * Compute a deterministic event ID from the canonical fields. Two
 * identical milestones raised at the exact same `raised_xlm` and
 * percentage produce the same id — receivers (and our DLQ row) use
 * this to dedupe replays.
 *
 * @param {{ projectId: string, milestoneId: string, percentage: number, raisedXlm: string }} input
 * @returns {string} lowercase hex sha256
 */
function computeEventId(input) {
  const hash = crypto.createHash("sha256");
  hash.update(String(input.projectId));
  hash.update("|");
  hash.update(String(input.milestoneId ?? ""));
  hash.update("|");
  hash.update(String(input.percentage));
  hash.update("|");
  hash.update(String(input.raisedXlm ?? ""));
  return hash.digest("hex");
}

/**
 * Compute the GitHub-style signature header value with dual-version support.
 *
 * Format: `t=<unix>,kid=<key-id>,v1=<hex>,v2=<hex>`. The keyed-hash message is `t.body`.
 *
 * Dual-version signing: both current and previous secrets are used to create signatures.
 * The kid header identifies the primary key version used for v1 signature.
 *
 * @param {string} body  raw request body (must be the exact bytes signed)
 * @param {string} currentSecret current project-scoped HMAC secret
 * @param {string} previousSecret previous project-scoped HMAC secret (optional)
 * @param {number} timestamp unix seconds
 * @param {string} keyId key identifier for the current secret
 * @returns {string}
 */
function sign(body, currentSecret, timestamp, previousSecret = null, keyId = "v1") {
  const currentMac = crypto
    .createHmac("sha256", currentSecret)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  let signature = `t=${timestamp},kid=${keyId},v1=${currentMac}`;

  // Add signature from previous secret if available (dual-version signing)
  if (previousSecret) {
    const previousMac = crypto
      .createHmac("sha256", previousSecret)
      .update(`${timestamp}.${body}`)
      .digest("hex");
    signature += `,v2=${previousMac}`;
  }

  return signature;
}

/**
 * Constant-time verifier with multi-version secret support.
 *
 * Returns true iff:
 *   - signature header is well-formed,
 *   - timestamp is within `replayWindowSeconds` of `now`,
 *   - HMAC matches any of the provided secrets (current, previous, or next).
 *
 * Multi-version verification: accepts signatures from current, previous, and next
 * secrets (3-version window) to handle rotation gracefully.
 *
 * Used by the queue worker's cleanup step and by tests.
 *
 * @param {string} body raw body that was signed
 * @param {string[]} secrets array of project secrets to try (current, previous, next)
 * @param {string} signatureHeader value of `X-Webhook-Signature`
 * @param {number} now unix seconds (defaults to Date.now())
 * @param {number} replayWindowSeconds
 * @returns {boolean}
 */
function verify(
  body,
  secrets,
  signatureHeader,
  now = Math.floor(Date.now() / 1000),
  replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS,
) {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0)
    return false;

  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1
        ? [kv.trim(), ""]
        : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    }),
  );

  const t = Number.parseInt(parts.t, 10);
  if (!Number.isFinite(t)) return false;

  // Extract all signature versions (v1, v2, v3, etc.)
  const signatureVersions = [];
  for (const [key, value] of Object.entries(parts)) {
    if (key.startsWith("v") && typeof value === "string" && value.length > 0) {
      signatureVersions.push(value);
    }
  }

  if (signatureVersions.length === 0) return false;

  if (Math.abs(now - t) > replayWindowSeconds) return false;

  // Try each secret against each signature version
  for (const secret of secrets) {
    if (!secret || typeof secret !== "string") continue;

    for (const sigHex of signatureVersions) {
      const expected = crypto
        .createHmac("sha256", secret)
        .update(`${t}.${body}`)
        .digest();
      const got = Buffer.from(sigHex, "hex");
      if (got.length === expected.length && crypto.timingSafeEqual(got, expected)) {
        return true; // Valid signature found
      }
    }
  }

  return false; // No valid signature found
}

/**
 * Generate a key ID based on a timestamp and version number.
 * Format: `v{version}-{timestamp}` where timestamp is in ISO format.
 *
 * @param {number} version key version number
 * @param {Date} timestamp key creation timestamp
 * @returns {string}
 */
function generateKeyId(version = 1, timestamp = new Date()) {
  const dateStr = timestamp.toISOString().split("T")[0]; // YYYY-MM-DD
  return `v${version}-${dateStr}`;
}

/**
 * Parse a key ID to extract version and date.
 *
 * @param {string} keyId key ID in format `v{version}-{date}`
 * @returns {{version: number, date: string}|null}
 */
function parseKeyId(keyId) {
  const match = keyId.match(/^v(\d+)-(\d{4}-\d{2}-\d{2})$/);
  if (!match) return null;
  return {
    version: parseInt(match[1], 10),
    date: match[2],
  };
}

/**
 * Check if a key version has expired based on the grace period.
 *
 * @param {string} keyId key ID to check
 * @param {Date} now current timestamp
 * @returns {boolean}
 */
function isKeyExpired(keyId, now = new Date()) {
  const parsed = parseKeyId(keyId);
  if (!parsed) return false;

  const keyDate = new Date(parsed.date);
  const expiryDate = new Date(keyDate.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000);
  return now > expiryDate;
}

module.exports = {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  GRACE_PERIOD_DAYS,
  computeEventId,
  sign,
  verify,
  generateKeyId,
  parseKeyId,
  isKeyExpired,
};
