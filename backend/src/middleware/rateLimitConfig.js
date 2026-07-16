/**
 * src/middleware/rateLimitConfig.js
 *
 * Per-endpoint rate limit tier configuration for the Redis-backed rate
 * limiter. Supports two strategies:
 *
 *   1. Sliding window (default): `{ points, duration }`
 *      Limits to `points` requests per `duration` seconds using a Redis
 *      sorted set with timestamp-based sliding window.
 *
 *   2. Token bucket: `{ strategy: "token-bucket", capacity, refillRate }`
 *      A burst-tolerant algorithm. `capacity` is the max burst size, and
 *      `refillRate` is tokens added per second. Suited for endpoints that
 *      need to absorb short bursts (e.g. analytics, exports).
 *
 * Key format for patterns:
 *   "METHOD /path"       — exact match on METHOD and path
 *   "METHOD /path/*"     — wildcard match (e.g. /api/projects/anything)
 *   "/api/admin/*"       — any-method wildcard (lower priority than method-specific)
 *   "default"            — catch-all when no other pattern matches
 */
"use strict";

const RATE_LIMIT_TIERS = {
  // ── Write-heavy / mutation endpoints (strictest) ───────────────────────
  "POST /api/donations":                   { points: 10,  duration: 60   },  // 10 req / min (sliding window)
  "POST /api/verification-requests":       { points: 10,  duration: 900  },  // 10 req / 15 min
  "POST /api/projects":                    { points: 5,   duration: 60   },  // 5  req / min (registration)
  "PATCH /api/projects/*":                 { points: 20,  duration: 60   },  // 20 req / min (updates)
  "POST /api/profiles":                    { points: 10,  duration: 60   },
  "PATCH /api/profiles/*":                 { points: 10,  duration: 60   },
  "POST /api/ratings":                     { points: 10,  duration: 60   },
  "POST /api/uploads":                     { points: 10,  duration: 60   },

  // ── Admin endpoints ────────────────────────────────────────────────────
  "/api/admin/*":                          { points: 30,  duration: 60   },  // 30 req / min
  "POST /api/admin/*":                     { points: 20,  duration: 60   },

  // ── Read-heavy / listing endpoints (generous) ──────────────────────────
  "GET /api/projects/*":                   { points: 100, duration: 60   },  // 100 req / min
  "GET /api/leaderboard":                  { points: 60,  duration: 60   },
  "GET /api/stats":                        { points: 60,  duration: 60   },
  "GET /api/impact/*":                     { points: 60,  duration: 60   },
  "GET /api/map":                          { points: 60,  duration: 60   },

  // ── Analytics endpoint (token-bucket for burst tolerance) ──────────────
  "GET /api/analytics/*":                  {
    strategy: "token-bucket",
    capacity: 10,
    refillRate: 0.5,   // 1 token every 2 seconds → ~30 req / min sustained
  },

  // ── Notifications (mobile push) ────────────────────────────────────────
  "POST /api/notifications":               { points: 30,  duration: 60   },
  "POST /api/subscriptions":               { points: 20,  duration: 60   },

  // ── Default (catch-all fallback) ───────────────────────────────────────
  default:                                 { points: 150, duration: 900  },  // 150 req / 15 min
};

/**
 * Match a request's method + path against the configured tiers and return
 * the matching config. Matching is most-specific-first: an exact method +
 * path pattern wins over a wildcard which wins over 'default'.
 *
 * @param {string} method - HTTP method (GET, POST, PATCH, …)
 * @param {string} path   - URL path (e.g. /api/donations)
 * @returns {{ points: number, duration: number }}
 */
function getRateLimitConfig(method, path) {
  const normalizedPath = path.replace(/\/+$/, "") || "/";

  // 1. Try exact "METHOD /path" match first
  const exactKey = `${method} ${normalizedPath}`;
  if (RATE_LIMIT_TIERS[exactKey]) {
    return RATE_LIMIT_TIERS[exactKey];
  }

  // 2. Try method-specific wildcard: "METHOD /api/projects/*"
  const wildcardKey = `${method} ${normalizedPath.replace(/\/[^/]+$/, "/*")}`;
  if (RATE_LIMIT_TIERS[wildcardKey]) {
    return RATE_LIMIT_TIERS[wildcardKey];
  }

  // 3. Try wildcard patterns that didn't match in step 2.
  //    We check in two passes so method-specific patterns (e.g.
  //    "POST /api/admin/*") beat any-method patterns ("/api/admin/*").
  const wildcardPatterns = Object.entries(RATE_LIMIT_TIERS).filter(
    ([p]) => p !== "default" && p.includes("*"),
  );

  // 3a. Method-specific wildcards first (higher priority)
  for (const [pattern, config] of wildcardPatterns) {
    const parts = pattern.split(" ");
    if (parts.length < 2 || !parts[1]) continue;
    const patMethod = parts[0];
    if (patMethod !== method) continue;
    const patPathPrefix = parts[1].replace(/\*+$/, "");
    if (normalizedPath.startsWith(patPathPrefix)) {
      return config;
    }
  }

  // 3b. Any-method wildcards (lower priority)
  for (const [pattern, config] of wildcardPatterns) {
    const parts = pattern.split(" ");
    // Skip patterns that have a method prefix (already checked in 3a)
    if (parts.length >= 2 && parts[1]) continue;
    const patPathPrefix = parts[0].replace(/\*+$/, "");
    if (normalizedPath.startsWith(patPathPrefix)) {
      return config;
    }
  }

  // 4. Fall back to default
  return RATE_LIMIT_TIERS.default;
}

module.exports = { RATE_LIMIT_TIERS, getRateLimitConfig };
