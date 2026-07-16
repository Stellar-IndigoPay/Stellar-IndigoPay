"use strict";
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { sendAppError } = require("../errors");

function getSecret() {
  return process.env.JWT_SECRET || "dev-secret-do-not-use-in-prod";
}

function signToken(payload, expiresIn) {
  return jwt.sign(payload, getSecret(), { expiresIn });
}

function verifyToken(token) {
  return jwt.verify(token, getSecret());
}

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

function adminRequired(req, res, next) {
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
  try {
    const decoded = verifyToken(token);
    req.admin = decoded;
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return sendAppError(res, "TOKEN_EXPIRED");
    }
    return sendAppError(res, "UNAUTHORIZED", { reason: "Invalid token" });
  }
}

module.exports = {
  signToken,
  verifyToken,
  adminRequired,
  adminKeyRequired,
  isValidAdminKey,
};
