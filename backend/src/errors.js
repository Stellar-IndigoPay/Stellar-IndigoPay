"use strict";

/**
 * src/errors.js — structured error taxonomy (GF-055 / #106)
 *
 * Every code maps to a fixed HTTP status and a canonical, user-facing
 * English message. Call-site specifics (which field was invalid, which id
 * was missing, …) travel in `metadata` rather than by overriding the
 * message, so the same code always groups together for Sentry/analytics
 * regardless of the exact input that triggered it.
 *
 * Codes are grouped by the resource/HTTP-status family they belong to.
 * "Not found" in particular is split one code per resource (rather than a
 * single generic NOT_FOUND) because that granularity — telling a missing
 * project apart from a missing donation without parsing message strings —
 * is the entire point of this taxonomy.
 */

const ERROR_CODES = {
  // ── Auth (401-403) ────────────────────────────────────────────────────
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Access denied" },
  TOKEN_EXPIRED: { status: 401, message: "Token expired" },
  TOKEN_REVOKED: { status: 401, message: "Token has been revoked" },
  ORIGIN_NOT_ALLOWED: { status: 403, message: "Origin not allowed" },

  // ── Not Found (404) ───────────────────────────────────────────────────
  PROJECT_NOT_FOUND: { status: 404, message: "Project not found" },
  DONATION_NOT_FOUND: { status: 404, message: "Donation not found" },
  PROFILE_NOT_FOUND: { status: 404, message: "Donor profile not found" },
  VERIFICATION_NOT_FOUND: {
    status: 404,
    message: "Verification request not found",
  },
  JOB_NOT_FOUND: { status: 404, message: "Job not found" },
  MILESTONE_NOT_FOUND: { status: 404, message: "Milestone not found" },
  SUBSCRIPTION_NOT_FOUND: { status: 404, message: "Subscription not found" },
  UPDATE_NOT_FOUND: { status: 404, message: "Update not found" },
  DEVICE_TOKEN_NOT_FOUND: { status: 404, message: "Device token not found" },
  FILE_NOT_FOUND: { status: 404, message: "File not found" },
  NO_FEATURED_PROJECT: { status: 404, message: "No featured project found" },
  TX_NOT_FOUND: { status: 400, message: "Transaction not found on Stellar" },
  // Generic fallback for 404s that aren't raised via AppError (the
  // catch-all "no route matched" handler, and any stray library 404).
  NOT_FOUND: { status: 404, message: "Not found" },

  // ── Validation (400) ──────────────────────────────────────────────────
  VALIDATION_ERROR: { status: 400, message: "Validation failed" },
  INVALID_ADDRESS: { status: 400, message: "Invalid Stellar address" },
  INVALID_TX_HASH: { status: 400, message: "Invalid transaction hash" },
  INVALID_CURSOR: { status: 400, message: "Invalid pagination cursor" },
  TX_FAILED: { status: 400, message: "Transaction failed on Stellar" },
  INVALID_STATE_TRANSITION: {
    status: 400,
    message: "Invalid state transition",
  },
  UNSUPPORTED_FILE_TYPE: { status: 400, message: "Unsupported file type" },
  DUPLICATE_DONATION: { status: 409, message: "Donation already recorded" },
  DUPLICATE_SUBSCRIPTION: { status: 409, message: "Already subscribed" },

  // ── Rate limiting / payload (429, 413) ──────────────────────────────────
  RATE_LIMITED: { status: 429, message: "Too many requests" },
  FILE_TOO_LARGE: { status: 413, message: "File too large" },

  // ── Server (500-503) ────────────────────────────────────────────────────
  INTERNAL_ERROR: { status: 500, message: "Internal server error" },
  DB_ERROR: { status: 500, message: "Database error" },
  RPC_ERROR: { status: 502, message: "Soroban RPC unavailable" },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Service temporarily unavailable",
  },

  // ── Contract / business rules (400, 403) ────────────────────────────────
  CONTRACT_PAUSED: { status: 400, message: "Contract is paused" },
  PROJECT_PAUSED: { status: 400, message: "Project is temporarily paused" },
  INSUFFICIENT_BADGE: { status: 403, message: "Insufficient badge tier" },

  // ── Schema validation (422) ─────────────────────────────────────────────
  // Kept separate from VALIDATION_ERROR (400): the zod-backed body
  // validator has always returned 422 with a field->message `details`
  // map, and existing clients/tests depend on that status + shape.
  SCHEMA_VALIDATION_ERROR: { status: 422, message: "Validation failed" },
};

class AppError extends Error {
  constructor(code, metadata = {}) {
    const def = ERROR_CODES[code] || ERROR_CODES.INTERNAL_ERROR;
    super(def.message);
    this.name = "AppError";
    this.code = code in ERROR_CODES ? code : "INTERNAL_ERROR";
    this.status = def.status;
    this.metadata = metadata;
  }

  toJSON() {
    return {
      error: { code: this.code, message: this.message, ...this.metadata },
    };
  }
}

/**
 * Send an AppError as a response directly, for the handful of middleware
 * (auth, CORS, rate limiting) that have always responded inline instead of
 * delegating to the central error handler via `next()`. Kept inline rather
 * than switched to `next()` because these run ahead of route-level error
 * middleware in some mount points, and this keeps their behavior identical
 * regardless of what (if anything) is registered downstream.
 */
function sendAppError(res, code, metadata) {
  const err = new AppError(code, metadata);
  return res.status(err.status).json(err.toJSON());
}

module.exports = { AppError, ERROR_CODES, sendAppError };
