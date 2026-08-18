"use strict";

/**
 * Socket.IO handshake authentication.
 *
 * Every realtime event this server broadcasts (`newDonation`,
 * `donation_event`, `ai_summary_ready`, `profile_updated`, `impact_updated`,
 * `recurring_due`) carries donor-identifying data, so an unauthenticated
 * connection is an unauthenticated data feed. This middleware closes that:
 * a socket must present a valid, non-blacklisted access token before the
 * connection is accepted — the same JWT verification and `token_blacklist`
 * check the REST layer's `adminRequired` applies, enforced at the handshake.
 *
 * Tokens are read from the client's `auth` payload
 * (`io(url, { auth: { token } })`) with the `Authorization: Bearer` header
 * accepted as a fallback for clients that can only set headers.
 */

const { verifyToken, isBlacklisted } = require("./auth");

function extractToken(handshake = {}) {
  const fromAuth = handshake.auth?.token;
  if (fromAuth && typeof fromAuth === "string") return fromAuth;

  const header = handshake.headers?.authorization;
  if (header && header.startsWith("Bearer ")) return header.slice(7);

  return null;
}

/**
 * Fail closed: every rejection path calls `next` with an Error so
 * Socket.IO refuses the connection entirely — no room joins, no events.
 *
 * @param {import("socket.io").Socket} socket - Incoming socket; verified
 *   claims are attached to `socket.data.admin` for downstream handlers.
 * @param {Function} next - Socket.IO acceptance callback.
 * @returns {Promise<void>}
 */
async function socketAuth(socket, next) {
  const token = extractToken(socket.handshake);
  if (!token) {
    return next(new Error("unauthorized: missing access token"));
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    return next(new Error("unauthorized: invalid access token"));
  }

  if (!payload?.sub || !payload?.jti) {
    return next(new Error("unauthorized: malformed token claims"));
  }

  try {
    if (await isBlacklisted(payload.jti)) {
      return next(new Error("unauthorized: token revoked"));
    }
  } catch {
    // Fail closed: if the blacklist can't be consulted, the connection
    // doesn't happen — a blip in Postgres must not open the event stream.
    return next(new Error("unauthorized: token verification unavailable"));
  }

  socket.data.admin = { id: payload.sub, role: payload.role, jti: payload.jti };
  return next();
}

module.exports = { socketAuth, extractToken };
