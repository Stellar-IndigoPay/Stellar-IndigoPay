"use strict";
const express = require("express");
const router = express.Router();
const {
  listActiveSessions,
  revokeRefreshFamily,
  revokeAllSessionsExcept,
  findRefreshToken,
  adminRequired,
} = require("../../middleware/auth");
const { sendAppError } = require("../../errors");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * List the authenticated admin's active sessions, one per refresh-token family.
 *
 * Each session is flagged `current` when it belongs to the refresh-token
 * family presented in the caller's cookie, so an admin can tell which device
 * they are on.
 *
 * @route GET /api/admin/sessions
 * @param {import('express').Request} req - Express request with the authenticated admin context.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends one entry per active session, flagging the current one.
 * @throws {Error} If the session lookup fails.
 */
router.get("/", adminRequired, async (req, res, next) => {
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
 * Revoke every active session for the authenticated admin except the current
 * one (identified by the refresh-token family in the cookie).
 *
 * When no refresh cookie is present the current session cannot be identified,
 * so every session is revoked — a caller holding a valid access token can
 * simply log back in.
 *
 * @route DELETE /api/admin/sessions
 * @param {import('express').Request} req - Express request with the authenticated admin context.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the number of sessions revoked.
 * @throws {Error} If the revocation query fails.
 */
router.delete("/", adminRequired, async (req, res, next) => {
  try {
    const presented = req.cookies?.refresh_token;
    const currentFamily = presented
      ? ((await findRefreshToken(presented))?.family ?? null)
      : null;

    const revoked = await revokeAllSessionsExcept(
      req.admin.sub,
      currentFamily,
    );
    res.json({ success: true, data: { revoked } });
  } catch (e) {
    next(e);
  }
});

/**
 * Revoke one of the authenticated admin's session families.
 *
 * @route DELETE /api/admin/sessions/:family
 * @param {import('express').Request} req - Express request with the family to revoke.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends success, or an error when no active session matches.
 * @throws {Error} If the revocation query fails.
 */
router.delete("/:family", adminRequired, async (req, res, next) => {
  const { family } = req.params;
  if (!UUID_PATTERN.test(family)) {
    return sendAppError(res, "VALIDATION_ERROR", { field: "family" });
  }

  try {
    const revoked = await revokeRefreshFamily(family, req.admin.sub);
    if (revoked === 0) {
      return sendAppError(res, "NOT_FOUND", {
        reason: "No active session with that family",
      });
    }
    res.json({ success: true, data: { revoked } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
