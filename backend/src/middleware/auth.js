"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const pool = require("../db/pool");
const { sendAppError } = require("../errors");
const {
  currentKey: currentJwtSecret,
  keysForAcceptance: jwtAcceptanceKeys,
} = require("../services/signingSecretProvider");

const ACCESS_TOKEN_EXPIRY = "15m";
const ACCESS_TOKEN_EXPIRY_SECONDS = 900;
const REFRESH_TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Resolve the JWT signing secret.
 *
 * The multi-version provider (WS3 / #1100) is the source of truth when a
 * current key is configured. We keep the legacy fallback so dev environments
 * and tests that set JWT_SECRET directly continue to work unchanged.
 */
function getSecret() {
  try {
    return currentJwtSecret("JWT_SECRET");
  } catch {
    return process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod";
  }
}

/**
 * Sign a token using ONLY the current key. Old/next versions must not be used
 * to issue new credentials — that would make rotated-out secrets valid forever.
 */
function signToken(payload, expiresIn) {
  const secret = getSecret();
  const { keyIdFor } = require("../services/signingSecretProvider");
  const header = { kid: keyIdFor(secret) };
  return jwt.sign(payload, secret, { expiresIn, header });
}

/**
 * Verify a token against the current key and any still-valid rotated versions
 * (previous/next). During a zero-downtime rotation window a token that was
 * signed with the old key must still verify, but a token signed with a secret
 * we no longer know must be rejected. This is the dual-version acceptance
 * guarantee from WS3 / #1100.
 */
function verifyToken(token) {
  const keys = jwtAcceptanceKeys("JWT_SECRET");
  const candidates =
    keys.length > 0
      ? keys.map((k) => k.key)
      : [process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod"];
  let lastError;
  for (const candidate of candidates) {
    try {
      return jwt.verify(token, candidate);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("jwt malformed or no secret configured");
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
 * Revoke every session for an admin except one family (the caller's own).
 *
 * Used by `DELETE /api/admin/sessions` so an admin can kill every other
 * device without logging themselves out. Passing `null` for `exceptFamily`
 * revokes everything.
 *
 * @param {string} adminId - Admin whose sessions to revoke.
 * @param {string|null} exceptFamily - Refresh-token family to keep, or null.
 * @returns {Promise<number>} Number of tokens revoked.
 */
async function revokeAllSessionsExcept(adminId, exceptFamily) {
  const result = await pool.query(
    `UPDATE refresh_tokens SET revoked = true, revoked_at = NOW()
      WHERE admin_id = $1 AND revoked = false AND family IS DISTINCT FROM $2`,
    [adminId, exceptFamily ?? null],
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

// ── Password-based admin auth (issue #1123 Part B) ────────────────────────
// Admins can authenticate with email + bcrypt password instead of only a
// pre-shared API key, with an optional TOTP second factor. The admins table
// is created by migration 032; the existing X-Admin-Key path is unchanged.

const BCRYPT_ROUNDS = 12;
const TOTP_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

/**
 * Look up an admin by their (lowercase) email address.
 *
 * @param {string} email - Admin email.
 * @returns {Promise<{id: string, email: string, password_hash: string, mfa_secret: string|null, mfa_enabled: boolean}|null>}
 */
async function findAdminByEmail(email) {
  const result = await pool.query(
    `SELECT id, email, password_hash, mfa_secret, mfa_enabled, created_at
       FROM admins
      WHERE email = $1`,
    [String(email || "").toLowerCase().trim()],
  );
  return result.rows[0] || null;
}

/**
 * Look up an admin by id (used by MFA setup/verify, where the principal
 * comes from the access token's `sub` rather than an email).
 *
 * @param {string} id - Admin UUID.
 * @returns {Promise<{id: string, email: string, password_hash: string, mfa_secret: string|null, mfa_enabled: boolean}|null>}
 */
async function findAdminById(id) {
  const result = await pool.query(
    `SELECT id, email, password_hash, mfa_secret, mfa_enabled, created_at
       FROM admins
      WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

/**
 * Hash a plaintext admin password for storage.
 * @param {string} password
 * @returns {Promise<string>}
 */
async function hashAdminPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * Constant-time password comparison against a stored bcrypt hash.
 * @param {string} password - Plaintext candidate.
 * @param {string} hash - Stored bcrypt hash.
 * @returns {Promise<boolean>}
 */
async function verifyAdminPassword(password, hash) {
  if (!password || !hash) return false;
  return bcrypt.compare(password, hash);
}

/**
 * Persist a newly generated TOTP secret. MFA stays disabled until the
 * first code is verified (see enableAdminMfa).
 * @param {string} adminId
 * @param {string} secret - Base32 TOTP secret.
 */
async function setAdminMfaSecret(adminId, secret) {
  await pool.query("UPDATE admins SET mfa_secret = $1 WHERE id = $2", [
    secret,
    adminId,
  ]);
}

/**
 * Flip MFA on after a successful TOTP verification.
 * @param {string} adminId
 */
async function enableAdminMfa(adminId) {
  await pool.query("UPDATE admins SET mfa_enabled = true WHERE id = $1", [
    adminId,
  ]);
}

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += TOTP_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += TOTP_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

function base32Decode(input) {
  const cleaned = String(input).replace(/=+$/g, "").toUpperCase();
  const bytes = [];
  let bits = 0;
  let value = 0;
  for (const char of cleaned) {
    const index = TOTP_ALPHABET.indexOf(char);
    if (index === -1) throw new Error("Invalid base32 character in TOTP secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/**
 * Generate a fresh random TOTP secret (160 bits, base32-encoded).
 * @returns {string}
 */
function generateTotpSecret() {
  return base32Encode(crypto.randomBytes(20));
}

/**
 * Compute the RFC 6238 TOTP code for a secret at a given Unix time step.
 * @param {string} secret - Base32 TOTP secret.
 * @param {number} [timeStep] - Floor(unixTime / period). Defaults to now.
 * @returns {string} Zero-padded 6-digit code.
 */
function computeTotpCode(secret, timeStep = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS)) {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(timeStep));
  const hmac = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  // offset is derived from the HMAC digest itself and is always 0-15, so the
  // dynamic index into the fixed-size digest is safe.
  // eslint-disable-next-line security/detect-object-injection
  const first = (hmac[offset] & 0x7f) << 24;
  const binary =
    first |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/**
 * Verify a TOTP code with a ±1-step clock-skew window.
 * @param {string} secret - Base32 TOTP secret.
 * @param {string} code - Candidate 6-digit code.
 * @returns {boolean}
 */
function verifyTotpCode(secret, code) {
  if (typeof code !== "string" || !/^\d{6}$/.test(code)) return false;
  const current = Math.floor(Date.now() / 1000 / TOTP_PERIOD_SECONDS);
  for (let i = -1; i <= 1; i += 1) {
    if (computeTotpCode(secret, current + i) === code) return true;
  }
  return false;
}

/**
 * Build the otpauth:// provisioning URI for QR rendering.
 * @param {string} email - Admin email (account name).
 * @param {string} secret - Base32 TOTP secret.
 * @returns {string}
 */
function totpAuthUrl(email, secret) {
  const account = encodeURIComponent(`Stellar-IndigoPay:${email}`);
  return `otpauth://totp/${account}?secret=${secret}&issuer=Stellar-IndigoPay&algorithm=SHA1&digits=6&period=30`;
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
  // carrying the old shape is a leftover, not a credential. MFA-challenge
  // tokens are similarly short-lived single-purpose credentials that must
  // only ever be exchanged at /auth/login, never accepted as a session.
  if (decoded.type === "refresh" || decoded.type === "mfa-challenge") {
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
  revokeAllSessionsExcept,
  rotateRefreshToken,
  listActiveSessions,
  isBlacklisted,
  blacklistAccessToken,
  findAdminByEmail,
  findAdminById,
  hashAdminPassword,
  verifyAdminPassword,
  setAdminMfaSecret,
  enableAdminMfa,
  generateTotpSecret,
  computeTotpCode,
  verifyTotpCode,
  totpAuthUrl,
  adminRequired,
  adminKeyRequired,
  isValidAdminKey,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_MS,
};
