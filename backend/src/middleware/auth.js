"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const pool = require("../db/pool");
const { sendAppError } = require("../errors");

const ACCESS_TOKEN_EXPIRY = "15m";
const ACCESS_TOKEN_EXPIRY_SECONDS = 900;
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

function getSecret() {
  return process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod";
}

function signToken(payload, expiresIn) {
  return jwt.sign(payload, getSecret(), { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

function generateAccessToken(adminId, role = "admin") {
  return signToken(
    { sub: adminId, role, jti: crypto.randomUUID() },
    ACCESS_TOKEN_EXPIRY,
  );
}

// ── Refresh tokens ──────────────────────────────────────────────────────────
// Refresh tokens are opaque random strings, not JWTs: they carry no claims and
// only the hash is stored, so a dump of refresh_tokens yields nothing usable.

function hashRefreshToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function issueRefreshToken(adminId, family = crypto.randomUUID()) {
  const token = crypto.randomBytes(48).toString("hex");
  await pool.query(
    `INSERT INTO refresh_tokens (id, admin_id, token_hash, family, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      crypto.randomUUID(),
      adminId,
      hashRefreshToken(token),
      family,
      new Date(Date.now() + REFRESH_TOKEN_EXPIRY_MS),
    ],
  );
  return { token, family };
}

async function findRefreshToken(token) {
  const result = await pool.query(
    `SELECT id, admin_id, family, expires_at, revoked
       FROM refresh_tokens
      WHERE token_hash = $1`,
    [hashRefreshToken(token)],
  );
  return result.rows[0] || null;
}

async function revokeRefreshFamily(family, adminId) {
  const result = await pool.query(
    `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW()
      WHERE family = $1 AND admin_id = $2 AND revoked = false`,
    [family, adminId],
  );
  return result.rowCount || 0;
}

/**
 * Exchange a refresh token for its successor.
 *
 * The replacement inherits the family: reuse detection only works if every
 * token in a rotation chain shares one identifier, so a leaked token can be
 * traced back to the sessions minted from it.
 *
 * @param {string} presentedToken - Raw refresh token from the client cookie.
 * @returns {Promise<{outcome: "rotated"|"invalid"|"reused", token?: string, family?: string, adminId?: string}>}
 */
async function rotateRefreshToken(presentedToken) {
  const row = await findRefreshToken(presentedToken);
  if (!row) return { outcome: "invalid" };

  // An already-revoked token coming back means the chain leaked: either the
  // attacker or the legitimate holder is replaying a spent link, and there is
  // no way to tell which, so every session in the family goes.
  if (row.revoked) {
    await revokeRefreshFamily(row.family, row.admin_id);
    return { outcome: "reused", family: row.family, adminId: row.admin_id };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { outcome: "invalid" };
  }

  // Claim the token by revoking it, and let Postgres decide the winner: two
  // requests racing on the same token both read revoked = false above, so
  // whoever loses this UPDATE matches no row and is replaying a spent link.
  const claim = await pool.query(
    `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW()
      WHERE id = $1 AND revoked = false`,
    [row.id],
  );
  if (claim.rowCount === 0) {
    await revokeRefreshFamily(row.family, row.admin_id);
    return { outcome: "reused", family: row.family, adminId: row.admin_id };
  }

  const { token } = await issueRefreshToken(row.admin_id, row.family);
  return {
    outcome: "rotated",
    token,
    family: row.family,
    adminId: row.admin_id,
  };
}

/**
 * List an admin's active sessions, one per refresh-token family.
 *
 * Grouping happens here rather than in SQL because a session's start time comes
 * from the family's first token while its expiry comes from the live one.
 *
 * @param {string} adminId - Admin whose sessions to list.
 * @returns {Promise<Array<{id: string, createdAt: Date, expiresAt: Date}>>}
 */
async function listActiveSessions(adminId) {
  const result = await pool.query(
    `SELECT family, created_at, expires_at, revoked
       FROM refresh_tokens
      WHERE admin_id = $1 AND expires_at > NOW()
      ORDER BY created_at ASC`,
    [adminId],
  );

  // Rows arrive oldest-first, so the first one seen for a family is when the
  // session started. expiresAt stays null until a live token turns up, which
  // is also what marks the family as still being a session at all.
  const families = new Map();
  for (const row of result.rows) {
    if (!families.has(row.family)) {
      families.set(row.family, {
        id: row.family,
        createdAt: row.created_at,
        expiresAt: null,
      });
    }
    if (!row.revoked) {
      families.get(row.family).expiresAt = row.expires_at;
    }
  }

  return [...families.values()].filter((session) => session.expiresAt !== null);
}

// ── Access token revocation ─────────────────────────────────────────────────

async function isBlacklisted(jti) {
  const result = await pool.query(
    "SELECT 1 FROM token_blacklist WHERE jti = $1 AND expires_at > NOW()",
    [jti],
  );
  return result.rows.length > 0;
}

/**
 * Blacklist an access token until its natural expiry.
 *
 * Only tokens we signed get recorded. Logout is unauthenticated, so decoding
 * without verifying would let anyone write a chosen jti and expiry into the
 * table; and a token that fails verification is already refused by
 * adminRequired, so there is nothing to revoke.
 *
 * @param {string} token - Raw access token.
 * @returns {Promise<boolean>} Whether a jti was recorded.
 */
async function blacklistAccessToken(token) {
  let decoded;
  try {
    decoded = verifyToken(token);
  } catch {
    return false;
  }
  if (!decoded?.jti || !decoded?.exp) return false;
  await pool.query(
    `INSERT INTO token_blacklist (jti, expires_at) VALUES ($1, $2)
     ON CONFLICT (jti) DO NOTHING`,
    [decoded.jti, new Date(decoded.exp * 1000)],
  );
  return true;
}

// ── Admin key auth ──────────────────────────────────────────────────────────

function getConfiguredAdminKeys() {
  return [
    process.env.ADMIN_API_KEY,
    ...(process.env.ADMIN_API_KEYS || "").split(","),
  ]
    .map((key) => (typeof key === "string" ? key.trim() : ""))
    .filter(Boolean);
}

function timingSafeEquals(a, b) {
  const aHash = crypto.createHash("sha256").update(a).digest();
  const bHash = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function isValidAdminKey(value) {
  if (!value || typeof value !== "string") return false;
  return getConfiguredAdminKeys().some((configuredKey) =>
    timingSafeEquals(value, configuredKey),
  );
}

function attachAdminKeyPrincipal(req) {
  req.admin = {
    role: "admin",
    sub: "admin-key",
    authMethod: "x-admin-key",
  };
}

function adminKeyRequired(req, res, next) {
  const configuredKeys = getConfiguredAdminKeys();
  const adminKey = req.get("X-Admin-Key");

  if (!adminKey) {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Missing X-Admin-Key header",
    });
  }

  if (configuredKeys.length === 0) {
    return sendAppError(res, "SERVICE_UNAVAILABLE", {
      reason: "Admin key authentication not configured on this server",
    });
  }

  if (!isValidAdminKey(adminKey)) {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Invalid X-Admin-Key header",
    });
  }

  attachAdminKeyPrincipal(req);
  next();
}

async function adminRequired(req, res, next) {
  const adminKey = req.get("X-Admin-Key");
  if (adminKey && isValidAdminKey(adminKey)) {
    attachAdminKeyPrincipal(req);
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Missing or malformed Authorization header",
    });
  }
  const token = authHeader.slice(7);

  let decoded;
  try {
    decoded = verifyToken(token);
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return sendAppError(res, "TOKEN_EXPIRED");
    }
    return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid token" });
  }

  // Refresh tokens used to be JWTs that this middleware happily accepted as
  // access tokens. They are opaque and cookie-bound now, so a token still
  // carrying the old shape is a leftover, not a credential.
  if (decoded.type === "refresh") {
    return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid token" });
  }

  try {
    if (decoded.jti && (await isBlacklisted(decoded.jti))) {
      return sendAppError(res, "TOKEN_REVOKED");
    }
  } catch (err) {
    return next(err);
  }

  req.admin = decoded;
  next();
}

module.exports = {
  signToken,
  verifyToken,
  generateAccessToken,
  issueRefreshToken,
  findRefreshToken,
  revokeRefreshFamily,
  rotateRefreshToken,
  listActiveSessions,
  isBlacklisted,
  blacklistAccessToken,
  adminRequired,
  adminKeyRequired,
  isValidAdminKey,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_MS,
};
