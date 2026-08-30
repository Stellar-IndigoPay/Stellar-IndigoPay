"use strict";

/**
 * src/middleware/donorAuth.js — donor request authentication (issue #1102)
 *
 * Two complementary modes, selected by `DONOR_AUTH_LEGACY_TIMESTAMP_MODE`:
 *
 *   1. Nonce mode (default, `DONOR_AUTH_LEGACY_TIMESTAMP_MODE=false`):
 *      challenge/response replay protection. The donor requests a server-issued
 *      nonce from `GET /api/auth/challenge`, signs `nonce + method + path` with
 *      their Stellar keypair and sends it as:
 *        X-Donor-Address  — Stellar public key (G…)
 *        X-Donor-Nonce    — 64-char hex nonce from the challenge
 *        X-Donor-Signature— Ed25519 signature (base64 or hex) of the payload
 *      The nonce is single-use (atomic Redis claim) and bound to the HTTP
 *      method + path, so a captured `(nonce, method, path, signature)` tuple
 *      cannot be replayed to a different endpoint, and cannot be replayed at
 *      all within its TTL window.
 *
 *   2. Legacy timestamp mode (`DONOR_AUTH_LEGACY_TIMESTAMP_MODE=true`):
 *      the previous `X-Timestamp` / `X-Signature` flow, kept for backward
 *      compatibility during rollout.
 *
 * Configuration:
 *   - `DONOR_AUTH_NONCE_TTL_MS`            — challenge validity window
 *                                            (default 60_000).
 *   - `DONOR_AUTH_LEGACY_TIMESTAMP_MODE`   — "true" opts into the legacy
 *                                            timestamp flow (default "false").
 */

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const { AppError } = require("../errors");
const redis = require("../services/redis");

/** Challenge validity window in milliseconds (default 60s). */
const NONCE_TTL_MS = parseInt(process.env.DONOR_AUTH_NONCE_TTL_MS || "60000", 10);

/** Legacy timestamp-only mode flag (default false → nonce mode). */
const LEGACY_TIMESTAMP_MODE =
  String(process.env.DONOR_AUTH_LEGACY_TIMESTAMP_MODE || "false").toLowerCase() === "true";

/** A nonce is exactly 32 random bytes rendered as 64 lowercase hex chars. */
const NONCE_RE = /^[0-9a-f]{64}$/;

/** Timestamp window for the legacy mode (5 minutes, unchanged). */
const LEGACY_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Canonical payload a donor signs in nonce mode: `nonce + method + path`.
 * The nonce is a fixed-length 64-hex string and `method` is a fixed set of
 * uppercase verbs, so the concatenation is unambiguous. `path` is the full
 * request path (req.originalUrl), so the same signature can never be replayed
 * onto a different endpoint.
 *
 * @param {string} nonce - 64-char hex nonce
 * @param {string} method - HTTP method (GET/POST/…)
 * @param {string} path - full request path (req.originalUrl)
 * @returns {Buffer} bytes to sign/verify
 */
function buildSignedPayload(nonce, method, path) {
  return Buffer.from(`${nonce}${method}${path}`);
}

/**
 * Verify an Ed25519 signature over `payload` for a Stellar public key.
 * Accepts both hex and base64 signature encodings (as before).
 *
 * @param {string} donorAddress - Stellar public key (G…)
 * @param {Buffer} payload - bytes the signature must cover
 * @param {string} signature - hex or base64 Ed25519 signature
 * @returns {boolean}
 */
function verifySignature(donorAddress, payload, signature) {
  let keypair;
  try {
    keypair = Keypair.fromPublicKey(donorAddress);
  } catch {
    return false;
  }

  // Try hex first, then base64. A non-throwing `false` from the first
  // encoding must not short-circuit the second, and a valid Ed25519
  // signature is always exactly 64 bytes once decoded.
  for (const encoding of ["hex", "base64"]) {
    try {
      const decoded = Buffer.from(signature, encoding);
      if (decoded.length === 64 && keypair.verify(payload, decoded)) {
        return true;
      }
    } catch {
      // Try the next encoding.
    }
  }
  return false;
}

/**
 * Issue a fresh challenge nonce.
 *
 * Generates 32 cryptographically random bytes (OpenSSL CSPRNG, NIST
 * SP 800-90A compliant), stores the issued marker in Redis with the challenge
 * TTL, and returns the nonce plus its ISO-8601 expiry.
 *
 * @returns {Promise<{nonce: string, expiresAt: string}>}
 * @throws {AppError} SERVICE_UNAVAILABLE when the nonce cannot be persisted.
 */
async function issueDonorChallenge() {
  const nonce = crypto.randomBytes(32).toString("hex");
  const stored = await redis.storeDonorNonce(nonce, NONCE_TTL_MS);
  if (!stored) {
    throw new AppError("SERVICE_UNAVAILABLE", { detail: "Challenge issuance unavailable" });
  }
  const expiresAt = new Date(Date.now() + NONCE_TTL_MS).toISOString();
  return { nonce, expiresAt };
}

/**
 * Nonce-mode verification. See module docstring for the full protocol.
 *
 * @param {import('express').Request} req
 * @returns {Promise<void>} throws AppError on any failure
 */
async function verifyNonceAuth(req) {
  const donorAddress = req.headers["x-donor-address"];
  const nonce = req.headers["x-donor-nonce"];
  const signature = req.headers["x-donor-signature"];

  if (!donorAddress || !nonce || !signature) {
    throw new AppError("UNAUTHORIZED", { detail: "Missing donor authentication headers" });
  }
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) {
    throw new AppError("UNAUTHORIZED", { detail: "Invalid donor nonce" });
  }

  // 1) Binding check — the signature must cover the ACTUAL method + path of
  //    this request. A signature minted for GET /api/donor/stats can never be
  //    replayed on POST /api/donor/delete-account (or any other endpoint).
  const payload = buildSignedPayload(nonce, req.method, req.originalUrl);
  if (!verifySignature(donorAddress, payload, signature)) {
    throw new AppError("UNAUTHORIZED", {
      detail: "Invalid signature: method/path binding mismatch",
    });
  }

  // 2) Single-use claim — atomic SET NX inside the TTL window. A nonce can be
  //    consumed exactly once; a second use is a replay.
  const claim = await redis.claimDonorNonce(nonce, NONCE_TTL_MS);
  if (claim === "consumed") {
    throw new AppError("UNAUTHORIZED", { detail: "Nonce already consumed" });
  }
  if (claim !== "ok") {
    throw new AppError("SERVICE_UNAVAILABLE", { detail: "Nonce verification unavailable" });
  }

  // 3) Issued-marker check — the nonce must have been issued by the challenge
  //    endpoint and must not have expired. Unknown or expired nonces are
  //    rejected even though they were never consumed.
  const issued = await redis.donorNonceIssued(nonce);
  if (issued === null) {
    throw new AppError("SERVICE_UNAVAILABLE", { detail: "Nonce verification unavailable" });
  }
  if (!issued) {
    throw new AppError("UNAUTHORIZED", { detail: "Nonce expired" });
  }

  req.donorAddress = donorAddress;
  req.donorAuthNonce = nonce;
}

/**
 * Legacy timestamp-mode verification (unchanged behaviour, kept behind
 * `DONOR_AUTH_LEGACY_TIMESTAMP_MODE=true` for rollout backward compatibility).
 *
 * @param {import('express').Request} req
 * @throws {AppError} on any failure
 */
function verifyLegacyTimestampAuth(req) {
  const donorAddress = req.headers["x-donor-address"];
  const timestamp = req.headers["x-timestamp"];
  const signature = req.headers["x-signature"];

  if (!donorAddress || !timestamp || !signature) {
    throw new AppError("UNAUTHORIZED", { detail: "Missing donor authentication headers" });
  }

  const ts = parseInt(timestamp, 10);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > LEGACY_TIMESTAMP_WINDOW_MS) {
    throw new AppError("UNAUTHORIZED", { detail: "Timestamp expired or invalid" });
  }

  if (!verifySignature(donorAddress, Buffer.from(timestamp), signature)) {
    throw new AppError("UNAUTHORIZED", { detail: "Invalid signature" });
  }

  req.donorAddress = donorAddress;
}

/**
 * Express middleware: authenticate the donor for the current request.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
async function requireDonorAuth(req, res, next) {
  try {
    if (LEGACY_TIMESTAMP_MODE) {
      verifyLegacyTimestampAuth(req);
    } else {
      await verifyNonceAuth(req);
    }
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError("UNAUTHORIZED", { detail: "Invalid donor authentication payload" }));
    }
  }
}

module.exports = {
  requireDonorAuth,
  issueDonorChallenge,
  buildSignedPayload,
  NONCE_TTL_MS,
  LEGACY_TIMESTAMP_MODE,
};
