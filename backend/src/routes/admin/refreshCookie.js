"use strict";

// Refresh-token cookie helpers shared by the admin routers (admin.js and
// admin/auth.js). The cookie is scoped to /api rather than /api/admin: both
// routers are mounted under /api/admin and /api/v1/admin, and a narrower
// path would leave the versioned mount without a cookie.
const REFRESH_COOKIE = "refresh_token";

function refreshCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "strict",
    path: "/api",
  };
}

function setRefreshCookie(res, token, maxAge) {
  res.cookie(REFRESH_COOKIE, token, {
    ...refreshCookieOptions(),
    maxAge,
  });
}

function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, refreshCookieOptions());
}

module.exports = {
  REFRESH_COOKIE,
  refreshCookieOptions,
  setRefreshCookie,
  clearRefreshCookie,
};
