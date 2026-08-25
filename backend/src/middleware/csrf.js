"use strict";

/**
 * src/middleware/csrf.js
 *
 * CSRF protection with token rotation, method+path binding, and replay
 * protection.
 *
 * Wraps the `csurf` middleware and adds:
 *   1. Token rotation — a new CSRF secret is issued after each successful
 *      validated mutating request, so the previously issued token becomes
 *      invalid (session-lifetime replay is eliminated).
 *   2. Method+path binding — each token is bound to the HTTP method + path
 *      it was used for; replaying it for a different endpoint is rejected.
 *   3. Replay protection — used tokens are stored in Redis with a short TTL
 *      (5 minutes) so a rotated token cannot be replayed even if the secret
 *      rotation is bypassed.
 */

const crypto = require("crypto");
const csurf = require("csurf");
const { getClient } = require("../services/redis");

const USED_TOKEN_TTL = 300; // 5 minutes
const USED_TOKEN_PREFIX = "csrf:used:";
const CSRF_COOKIE_NAME = "_csrf";

const SAFE_METHODS = ["GET", "HEAD", "OPTIONS"];

/**
 * Extract the CSRF token from the request. csurf accepts the token from the
 * `X-CSRF-Token` header, `_csrf` body field, or `_csrf` query parameter.
 *
 * @param {import("express").Request} req
 * @returns {string|undefined}
 */
function getTokenFromRequest(req) {
  return (
    (req.body && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    req.headers["x-csrf-token"]
  );
}

/**
 * Redis key under which a used token is stored.
 * @param {string} token
 * @returns {string}
 */
function usedKey(token) {
  return `${USED_TOKEN_PREFIX}${token}`;
}

/**
 * Record a token as used, bound to the given method+path, with a short TTL.
 * Redis failures are non-fatal (rotation still proceeds).
 *
 * @param {string} token
 * @param {string} binding - e.g. "POST:/api/v1/ratings"
 * @returns {Promise<void>}
 */
async function markUsed(token, binding) {
  const key = usedKey(token);
  const client = getClient(key);
  await client.set(key, binding, "EX", USED_TOKEN_TTL);
}

/**
 * Return the stored binding for a token, or null if the token has not been
 * used (or Redis is unavailable).
 *
 * @param {string} token
 * @returns {Promise<string|null>}
 */
async function getUsedBinding(token) {
  const key = usedKey(token);
  const client = getClient(key);
  const value = await client.get(key);
  return value === null || value === undefined ? null : value;
}

/**
 * Rotate the CSRF secret by writing a fresh random secret to the cookie.
 * The next `GET /api/csrf-token` request will derive a token from the new
 * secret, so the previously issued token becomes invalid.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 */
function rotateSecret(req, res) {
  const newSecret = crypto.randomBytes(24).toString("base64");
  res.cookie(CSRF_COOKIE_NAME, newSecret, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "none",
    path: "/",
  });
}

/**
 * Build the CSRF protection middleware.
 *
 * @param {object} [options] - Extra options passed through to csurf.
 * @returns {import("express").RequestHandler}
 */
function createCsrfProtection(options = {}) {
  const base = csurf({
    cookie: {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "none",
      path: "/",
    },
    ignoreMethods: SAFE_METHODS,
    ...options,
  });

  return function csrfProtection(req, res, next) {
    const isMutating = !SAFE_METHODS.includes(req.method);
    const token = getTokenFromRequest(req);

    // For mutating requests, reject any token that has already been used
    // (replay / method+path binding violation) before csurf validation.
    if (isMutating && token) {
      getUsedBinding(token)
        .then((usedBinding) => {
          if (usedBinding !== null) {
            const err = new Error("invalid csrf token");
            err.status = 403;
            err.code = "EBADCSRFTOKEN";
            return next(err);
          }
          return runValidation(req, res, next, base, token);
        })
        .catch(() => runValidation(req, res, next, base, token));
      return;
    }

    return runValidation(req, res, next, base, token);
  };
}

/**
 * Run the underlying csurf validation, then (for successful mutating
 * requests) mark the token as used and rotate the secret.
 *
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 * @param {import("express").RequestHandler} base
 * @param {string|undefined} token
 */
function runValidation(req, res, next, base, token) {
  const isMutating = !SAFE_METHODS.includes(req.method);

  base(req, res, (err) => {
    if (err) return next(err);

    if (isMutating && token) {
      const binding = `${req.method}:${req.path}`;
      markUsed(token, binding)
        .then(() => {
          rotateSecret(req, res);
          next();
        })
        .catch(() => {
          // Redis failure is non-fatal; still rotate.
          rotateSecret(req, res);
          next();
        });
    } else {
      next();
    }
  });
}

module.exports = {
  createCsrfProtection,
  getTokenFromRequest,
  markUsed,
  getUsedBinding,
  rotateSecret,
  USED_TOKEN_TTL,
  USED_TOKEN_PREFIX,
  CSRF_COOKIE_NAME,
};
