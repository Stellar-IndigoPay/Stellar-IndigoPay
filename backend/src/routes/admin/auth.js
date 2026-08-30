"use strict";
const express = require("express");
const router = express.Router();
const qrcode = require("qrcode");
const {
  generateAccessToken,
  issueRefreshToken,
  signToken,
  verifyToken,
  findAdminByEmail,
  findAdminById,
  verifyAdminPassword,
  setAdminMfaSecret,
  enableAdminMfa,
  generateTotpSecret,
  verifyTotpCode,
  totpAuthUrl,
  adminRequired,
  ACCESS_TOKEN_EXPIRY_SECONDS,
  REFRESH_TOKEN_EXPIRY_MS,
} = require("../../middleware/auth");
const { createRateLimiter } = require("../../middleware/rateLimiter");
const { sendAppError } = require("../../errors");
const {
  setRefreshCookie,
} = require("./refreshCookie");

const loginLimiter = createRateLimiter(10, 15);
// Short-lived single-purpose credential handed out once the password checks
// out but MFA is still pending. It is only ever exchanged at /auth/login
// with a valid TOTP code; adminRequired rejects the type outright.
const MFA_CHALLENGE_EXPIRY = "5m";

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
 * Issue a refresh token, set the httpOnly cookie, and return the access
 * token — the shared happy path for every successful credential exchange.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {string} adminId - Admin UUID from the admins table.
 * @returns {Promise<import('express').Response>}
 */
async function openSession(res, adminId) {
  const { token } = await issueRefreshToken(adminId);
  setRefreshCookie(res, token, REFRESH_TOKEN_EXPIRY_MS);
  return res.json(accessTokenPayload(adminId));
}

/**
 * Complete the second leg of an MFA login: the client already proved its
 * password in the first leg and received a short-lived mfa-challenge token.
 * Resolve the admin from the challenge, require a valid TOTP code, and only
 * then open a session — so the password is never sent over the wire twice.
 *
 * @param {import('express').Response} res - Express response object.
 * @param {string} challengeToken - Signed mfa-challenge JWT from the first leg.
 * @param {string} totpCode - Candidate 6-digit TOTP code.
 * @returns {Promise<import('express').Response>}
 */
async function completeMfaLogin(res, challengeToken, totpCode) {
  let decoded;
  try {
    decoded = verifyToken(challengeToken);
  } catch {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Invalid or expired MFA challenge",
    });
  }

  if (!decoded || decoded.type !== "mfa-challenge" || !decoded.sub) {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Invalid or expired MFA challenge",
    });
  }

  const admin = await findAdminById(decoded.sub);
  if (!admin || !admin.mfa_enabled || !admin.mfa_secret) {
    return sendAppError(res, "UNAUTHORIZED", {
      reason: "Invalid or expired MFA challenge",
    });
  }

  if (!verifyTotpCode(admin.mfa_secret, totpCode)) {
    return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid TOTP code" });
  }

  return openSession(res, admin.id);
}

/**
 * Authenticate an administrator with email + password, or complete an MFA
 * login with a challenge token + TOTP code.
 *
 * Behaviour by state:
 *   - No account / wrong password → 401 (single generic message so the
 *     endpoint cannot be used to enumerate which emails have accounts).
 *   - MFA disabled → access + refresh tokens immediately.
 *   - MFA enabled, no code yet → 200 with `mfaRequired: true` and a
 *     short-lived `mfaChallenge` token.
 *   - MFA enabled, code present (either alongside the password or via the
 *     challenge token) → session if the code verifies, otherwise 401.
 *
 * @route POST /api/admin/auth/login
 * @param {import('express').Request} req - Express request with admin credentials.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>}
 */
router.post("/login", loginLimiter, async (req, res, next) => {
  try {
    const { email, password, totpCode, mfaChallenge } = req.body || {};

    // Second leg: the challenge token already proves the password, so the
    // admin is resolved from it instead of re-asking for credentials.
    if (mfaChallenge) {
      return completeMfaLogin(res, mfaChallenge, totpCode);
    }

    const admin = await findAdminByEmail(email);
    const passwordOk = admin
      ? await verifyAdminPassword(password, admin.password_hash)
      : false;
    if (!admin || !passwordOk) {
      return sendAppError(res, "UNAUTHORIZED", {
        reason: "Invalid credentials",
      });
    }

    if (!admin.mfa_enabled) {
      return openSession(res, admin.id);
    }

    if (totpCode) {
      if (!verifyTotpCode(admin.mfa_secret, totpCode)) {
        return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid TOTP code" });
      }
      return openSession(res, admin.id);
    }

    const challenge = signToken(
      { sub: admin.id, type: "mfa-challenge" },
      MFA_CHALLENGE_EXPIRY,
    );
    return res.json({
      success: true,
      data: { mfaRequired: true, mfaChallenge: challenge },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Generate a fresh TOTP secret for the authenticated admin and return it
 * along with a QR code (data URL) the authenticator app can scan.
 *
 * MFA stays disabled until the first code is verified at /auth/mfa/verify,
 * so a half-finished setup can never lock an admin out. Calling setup again
 * before verification simply replaces the secret.
 *
 * @route POST /api/admin/auth/mfa/setup
 * @param {import('express').Request} req - Express request with the authenticated admin context.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>}
 */
router.post("/mfa/setup", adminRequired, async (req, res, next) => {
  try {
    const admin = await findAdminById(req.admin.sub);
    if (!admin) {
      return sendAppError(res, "NOT_FOUND", {
        reason: "No password account for this admin",
      });
    }
    if (admin.mfa_enabled) {
      return sendAppError(res, "CONFLICT", {
        reason: "MFA is already enabled",
      });
    }

    const secret = generateTotpSecret();
    await setAdminMfaSecret(admin.id, secret);

    const otpauthUrl = totpAuthUrl(admin.email, secret);
    const qrCode = await qrcode.toDataURL(otpauthUrl);
    return res.json({
      success: true,
      data: { secret, otpauthUrl, qrCode },
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Verify a TOTP code against the pending secret and enable MFA for the
 * authenticated admin.
 *
 * @route POST /api/admin/auth/mfa/verify
 * @param {import('express').Request} req - Express request with the code to verify.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>}
 */
router.post("/mfa/verify", adminRequired, async (req, res, next) => {
  try {
    const admin = await findAdminById(req.admin.sub);
    if (!admin) {
      return sendAppError(res, "NOT_FOUND", {
        reason: "No password account for this admin",
      });
    }
    if (admin.mfa_enabled) {
      return sendAppError(res, "CONFLICT", {
        reason: "MFA is already enabled",
      });
    }
    if (!admin.mfa_secret) {
      return sendAppError(res, "CONFLICT", {
        reason: "Run MFA setup before verifying",
      });
    }

    const { totpCode } = req.body || {};
    if (!verifyTotpCode(admin.mfa_secret, totpCode)) {
      return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid TOTP code" });
    }

    await enableAdminMfa(admin.id);
    return res.json({ success: true, data: { mfaEnabled: true } });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
