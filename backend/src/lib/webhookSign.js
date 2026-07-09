"use strict";

/**
 * lib/webhookSign.js
 *
 * Reusable helpers for signing webhook payloads in the GitHub style:
 *
 *   X-Webhook-Id:        <uuid>
 *   X-Webhook-Timestamp: <unix seconds>
 *   X-Webhook-Signature: t=<unix>,v1=<hex hmac-sha256>
 *
 * Receivers verify by recomputing HMAC over `t.<raw body>` using the
 * project secret, then rejecting events whose timestamp is older than
 * REPLAY_WINDOW_SECONDS (default 5 minutes). This defends against
 * intercept-and-replay attacks and accidental duplicate deliveries.
 */

const crypto = require("crypto");

const DEFAULT_REPLAY_WINDOW_SECONDS = 5 * 60;

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
 * Compute the GitHub-style signature header value.
 *
 * Format: `t=<unix>,v1=<hex>`. The keyed-hash message is `t.body`.
 *
 * @param {string} body  raw request body (must be the exact bytes signed)
 * @param {string} secret project-scoped HMAC secret
 * @param {number} timestamp unix seconds
 * @returns {string}
 */
function sign(body, secret, timestamp) {
  const mac = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/**
 * Constant-time verifier. Returns true iff:
 *   - signature header is well-formed,
 *   - timestamp is within `replayWindowSeconds` of `now`,
 *   - HMAC matches.
 *
 * Used by the queue worker's cleanup step and by tests.
 *
 * @param {string} body raw body that was signed
 * @param {string} secret project secret
 * @param {string} signatureHeader value of `X-Webhook-Signature`
 * @param {number} now unix seconds (defaults to Date.now())
 * @param {number} replayWindowSeconds
 * @returns {boolean}
 */
function verify(body, secret, signatureHeader, now = Math.floor(Date.now() / 1000), replayWindowSeconds = DEFAULT_REPLAY_WINDOW_SECONDS) {
  if (typeof signatureHeader !== "string" || signatureHeader.length === 0) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(",").map((kv) => {
      const idx = kv.indexOf("=");
      return idx === -1 ? [kv.trim(), ""] : [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()];
    })
  );
  const t = Number.parseInt(parts.t, 10);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || typeof v1 !== "string" || v1.length === 0) return false;
  if (Math.abs(now - t) > replayWindowSeconds) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${t}.${body}`)
    .digest();
  const got = Buffer.from(v1, "hex");
  if (got.length !== expected.length) return false;
  return crypto.timingSafeEqual(got, expected);
}

module.exports = {
  DEFAULT_REPLAY_WINDOW_SECONDS,
  computeEventId,
  sign,
  verify,
};
