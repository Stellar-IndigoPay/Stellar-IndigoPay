"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const logger = require("../logger");
const {
  generateAccessToken,
  issueRefreshToken,
  findRefreshToken,
  revokeRefreshFamily,
  rotateRefreshToken,
  listActiveSessions,
  blacklistAccessToken,
  adminRequired,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_MS,
} = require("../middleware/auth");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { sendAppError } = require("../errors");
const { buildAuditFilters } = require("./admin/audit-export");
const { enqueueDigest } = require("../services/digestQueue");

const loginLimiter = createRateLimiter(10, 15);

const REFRESH_COOKIE = "refresh_token";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Scoped to /api rather than /api/admin: this router is mounted under both
// /api/admin and /api/v1/admin, and a narrower path would leave the versioned
// mount without a cookie.
function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
  };
}

function setRefreshCookie(res, token) {
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(),
    maxAge: REFRESH_TOKEN_EXPIRY_MS,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

function accessTokenPayload(adminId) {
  return {
    success: true,
    data: {
      token: generateAccessToken(adminId),
      expiresIn: ACCESS_TOKEN_EXPIRY_SECONDS,
    },
  };
}

/**
 * Authenticate an administrator and open a session.
 *
 * @route POST /api/admin/login
 * @param {import('express').Request} req - Express request with admin credentials.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the access token and sets the refresh cookie.
 * @throws {Error} If the admin credentials are invalid or the server is not configured.
 */
router.post("/login", loginLimiter, async (req, res, next) => {
  const { username, password } = req.body || {};
  const adminUser = process.env.ADMIN_USERNAME || "admin";
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    return sendAppError(res, "SERVICE_UNAVAILABLE", {
      reason: "Admin authentication not configured on this server",
    });
  }

  if (username !== adminUser || password !== adminPass) {
    return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid credentials" });
  }

  try {
    const { token } = await issueRefreshToken(username);
    setRefreshCookie(res, token);
    return res.json(accessTokenPayload(username));
  } catch (e) {
    next(e);
  }
});

/**
 * Rotate the refresh cookie and issue a fresh access token.
 *
 * @route POST /api/admin/refresh
 * @param {import('express').Request} req - Express request carrying the refresh cookie.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends a new access token or an auth error.
 * @throws {Error} If the refresh token is missing, expired, or replayed.
 */
router.post("/refresh", async (req, res, next) => {
  const presented = req.cookies?.refresh_token;
  if (!presented) {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Missing refresh token",
    });
  }

  try {
    const result = await rotateRefreshToken(presented);

    if (result.outcome === "reused") {
      logger.warn(
        {
          event: "token_reuse_detected",
          family: result.family,
          adminId: result.adminId,
        },
        "Refresh token replayed; every session in the family was revoked",
      );
      clearRefreshCookie(res);
      return sendAppError(res, "TOKEN_REVOKED", {
        reason: "Token reuse detected — all sessions revoked",
      });
    }

    if (result.outcome === "invalid") {
      clearRefreshCookie(res);
      return sendAppError(res, "UNAUTHORIZED", {
        reason: "Invalid or expired refresh token",
      });
    }

    setRefreshCookie(res, result.token);
    return res.json(accessTokenPayload(result.adminId));
  } catch (e) {
    next(e);
  }
});

/**
 * End the current admin session.
 *
 * @route POST /api/admin/logout
 * @param {import('express').Request} req - Express request with the session cookie and bearer token.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Always reports success once the session is torn down.
 * @throws {Error} If revoking the session fails.
 */
router.post("/logout", async (req, res, next) => {
  try {
    const presented = req.cookies?.refresh_token;
    if (presented) {
      const row = await findRefreshToken(presented);
      // The whole family goes, not just the presented link: logging out of a
      // session that could still be rotated forward is not logging out.
      if (row) await revokeRefreshFamily(row.family, row.admin_id);
    }

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      await blacklistAccessToken(authHeader.slice(7));
    }

    clearRefreshCookie(res);
    return res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

/**
 * List the authenticated admin's active sessions.
 *
 * @route GET /api/admin/sessions
 * @param {import('express').Request} req - Express request with the authenticated admin context.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends one entry per active session, flagging the current one.
 * @throws {Error} If the session lookup fails.
 */
router.get("/sessions", adminRequired, async (req, res, next) => {
  try {
    const sessions = await listActiveSessions(req.admin.sub);

    const presented = req.cookies?.refresh_token;
    const currentFamily = presented
      ? ((await findRefreshToken(presented))?.family ?? null)
      : null;

    res.json({
      success: true,
      data: sessions.map((session) => ({
        ...session,
        current: session.id === currentFamily,
      })),
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Revoke one of the authenticated admin's sessions.
 *
 * @route POST /api/admin/sessions/:id/revoke
 * @param {import('express').Request} req - Express request with the session id to revoke.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends success, or an error when no active session matches.
 * @throws {Error} If the revocation query fails.
 */
router.post("/sessions/:id/revoke", adminRequired, async (req, res, next) => {
  const { id } = req.params;
  if (!UUID_PATTERN.test(id)) {
    return sendAppError(res, "VALIDATION_ERROR", { field: "id" });
  }

  try {
    const revoked = await revokeRefreshFamily(id, req.admin.sub);
    if (revoked === 0) {
      return sendAppError(res, "NOT_FOUND", {
        reason: "No active session with that id",
      });
    }
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

router.post("/digest/trigger", adminRequired, async (req, res, next) => {
  try {
    const { type } = req.body || {};
    const allowedTypes = new Set(["daily", "weekly"]);

    if (type !== undefined && !allowedTypes.has(type)) {
      return sendAppError(res, "VALIDATION_ERROR", {
        field: "type",
        detail: "type must be either daily or weekly",
      });
    }

    const requestedTypes = type ? [type] : ["daily", "weekly"];
    for (const digestType of requestedTypes) {
      await enqueueDigest(digestType);
    }

    res.json({ success: true, data: { triggered: requestedTypes } });
  } catch (e) {
    next(e);
  }
});

/**
 * Return the authenticated admin identity.
 *
 * @route GET /api/admin/me
 * @param {import('express').Request} req - Express request with the authenticated admin context.
 * @param {import('express').Response} res - Express response object.
 * @returns {void} Sends the admin profile payload.
 * @throws {Error} If the request is missing a valid bearer token.
 */
router.get("/me", adminRequired, (req, res) => {
  res.json({
    success: true,
    data: {
      username: req.admin.sub,
      role: req.admin.role,
    },
  });
});

/**
 * Query the admin audit log with optional filters and pagination.
 *
 * @route GET /api/admin/audit-log
 * @param {import('express').Request} req - Express request with audit log filters.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the audit log page and metadata.
 * @throws {Error} If the audit log query fails.
 */
router.get("/audit-log", adminRequired, async (req, res, next) => {
  try {
    const {
      actor,
      action,
      targetType,
      targetId,
      ipAddress,
      dateFrom,
      dateTo,
      metadataKey,
      metadataValue,
      page = "1",
      pageSize = "50",
    } = req.query;

    const { where, values } = buildAuditFilters(
      { actor, action, targetType, targetId, ipAddress, dateFrom, dateTo, metadataKey, metadataValue },
    );

    const limit = Math.min(Number.parseInt(pageSize, 10) || 50, 200);
    const offset = (Math.max(Number.parseInt(page, 10) || 1, 1) - 1) * limit;
    values.push(limit, offset);

    // eslint-disable-next-line sql-injection/no-sql-injection
    let query =
      "SELECT id, actor, action, target_type, target_id, metadata, ip_address, created_at, prev_hash, row_hash FROM admin_audit_log";
    if (where.length) {
      // eslint-disable-next-line sql-injection/no-sql-injection
      query += " WHERE " + where.join(" AND ");
    }
    query += ` ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`;

    // eslint-disable-next-line sql-injection/no-sql-injection
    let countQuery = "SELECT COUNT(*)::bigint AS total FROM admin_audit_log";
    if (where.length) {
      // eslint-disable-next-line sql-injection/no-sql-injection
      countQuery += " WHERE " + where.join(" AND ");
    }

    const startedAt = Date.now();
    // eslint-disable-next-line sql-injection/no-sql-injection
    const result = await pool.query(query, values);
    // eslint-disable-next-line sql-injection/no-sql-injection
    const countResult = await pool.query(countQuery, values.slice(0, -2));
    const queryTimeMs = Date.now() - startedAt;

    res.json({
      success: true,
      data: result.rows,
      total: Number(countResult.rows[0].total),
      page: parseInt(page, 10),
      pageSize: limit,
      queryTimeMs,
    });
  } catch (e) {
    next(e);
  }
});

// Audit log sub-resources: export + stats. Mounted before the catch-all
// `/audit-log` GET above would otherwise shadow them — Express matches the
// more specific registered routes first within this router.
router.use("/audit-log", require("./admin/audit-export"));
router.use("/audit-log", require("./admin/audit-stats"));

router.use("/queues", require("./admin/queues"));
router.use("/co2", require("./admin/co2"));
router.use("/documents", require("./admin/documents"));
router.use("/webhooks", require("./admin/webhooks"));
router.use("/indexer", require("./admin/indexer"));
router.use("/secret-rotations", require("./admin/secretRotations"));

module.exports = router;
