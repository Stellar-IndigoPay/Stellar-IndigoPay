/**
 * src/middleware/rateLimiter.js
 *
 * Rate limiting middleware for Stellar IndigoPay.
 *
 * Exports:
 *   - createRateLimiter(maxRequests, windowMinutes)
 *       Legacy factory backed by express-rate-limit (in-memory). Used by
 *       route-specific limiters in donations.js & verification.js.
 *
 *   - redisRateLimiter(req, res, next)
 *       Per-endpoint Redis-backed rate limiter that dispatches to the
 *       appropriate strategy (sliding window or token bucket) based on the
 *       endpoint config in rateLimitConfig.js.
 *       Falls back to in-memory (no-op pass-through) when Redis is
 *       unavailable so the API stays up during a cache outage.
 *
 *   - slidingWindowRateLimit(key, limit, windowMs)
 *       Core Redis sorted-set algorithm. Exported for direct use / testing.
 *
 *   - tokenBucketRateLimit(key, capacity, refillRate)
 *       Redis-backed token bucket algorithm using a Lua script for atomic
 *       check-and-consume. Exported for direct use / testing.
 */

"use strict";

const rateLimit = require("express-rate-limit");
const logger = require("../logger");
const { sendAppError } = require("../errors");

// Re-export the legacy factory unchanged so existing route-level limiters
// continue to work without modification.
const createRateLimiter = (maxRequests, windowMinutes) => {
  return rateLimit({
    windowMs: windowMinutes * 60 * 1000,
    max: maxRequests,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      (req.log || logger).warn(
        {
          event: "rate_limit_hit",
          ip: req.ip,
          path: req.path,
          method: req.method,
          limit: maxRequests,
          windowMinutes,
        },
        "Rate limit exceeded",
      );
      res.set("Retry-After", Math.ceil(windowMinutes * 60));
      return sendAppError(res, "RATE_LIMITED");
    },
  });
};

// ── Redis sliding window helpers ────────────────────────────────────────────

const redisService = require("../services/redis");
const { getRateLimitConfig } = require("./rateLimitConfig");

// Prometheus metrics — registered on the shared registry so the /metrics
// endpoint emits them automatically. Both strategies share the same metric
// names, distinguished by a `strategy` label.
const client = require("prom-client");
const { registry } = require("../services/metrics");

const rateLimitRemaining = new client.Gauge({
  name: "indigopay_rate_limit_remaining",
  help: "Rate limit remaining capacity per endpoint, labelled by strategy (sliding-window|token-bucket).",
  labelNames: ["endpoint", "strategy"],
  registers: [registry],
});

const rateLimitHitsTotal = new client.Counter({
  name: "indigopay_rate_limit_hits_total",
  help: "Total number of rate-limited (429) responses per endpoint, labelled by strategy.",
  labelNames: ["method", "endpoint", "strategy"],
  registers: [registry],
});

/**
 * Sliding-window rate-limit check using a Redis sorted set.
 *
 * Algorithm:
 *   1. Add current timestamp as a member of the sorted set.
 *   2. Remove entries older than `windowMs`.
 *   3. Count remaining (non-expired) entries.
 *   4. Set key TTL for automatic cleanup.
 *
 * @param {string}  key      Redis key (e.g. "ratelimit:sw:1.2.3.4:POST:/api/donations")
 * @param {number}  limit    Max number of requests allowed in the window
 * @param {number}  windowMs Window duration in milliseconds
 * @returns {Promise<{ allowed: boolean, remaining: number, reset: number, limit: number }>}
 */
async function slidingWindowRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const windowStart = now - windowMs;
  const member = `${now}-${Math.random()}`;
  const client = redisService.getClient();

  // ── Pipeline: batch all Redis commands into one round-trip ────────────
  const pipeline = client.pipeline();
  pipeline.zadd(key, now, member);
  pipeline.zremrangebyscore(key, 0, windowStart);
  pipeline.zcard(key);
  pipeline.expire(key, Math.ceil(windowMs / 1000));
  const results = await pipeline.exec();

  // pipeline.exec() returns [[err, result], …]. We ignore errors for the
  // add/remove steps and only read the count from the zcard result (index 2).
  const count = results[2] && results[2][1] !== undefined ? results[2][1] : 0;
  const remaining = Math.max(0, limit - count);
  // Reset timestamp (seconds since epoch) when the oldest entry expires.
  const reset = Math.ceil((now + windowMs - (now - windowStart)) / 1000);

  return { allowed: count <= limit, remaining, reset, limit };
}

// ── Token bucket Redis Lua script (SHA cached) ─────────────────────────────

/**
 * Lua script for atomic token bucket check-and-consume.
 *
 * KEYS[1] = Redis key (e.g. "ratelimit:tb:1.2.3.4:GET:/api/analytics/foo")
 * ARGV[1] = capacity (max tokens / burst size)
 * ARGV[2] = refillRate (tokens added per second)
 * ARGV[3] = now (current epoch ms)
 * ARGV[4] = cost (typically 1)
 *
 * Returns: { allowed (0|1), remaining (float), next_refill_seconds }
 *   - allowed: 1 if enough tokens were available and consumed
 *   - remaining: fractional tokens remaining in the bucket
 *   - next_refill_seconds: epoch seconds when the next full token will be
 *     available (used for Retry-After header); returns 0 if already allowed.
 *
 * The script handles first-time keys (no bucket exists) by initialising
 * the bucket to full capacity.
 */
const TOKEN_BUCKET_LUA = `
  local key = KEYS[1]
  local capacity = tonumber(ARGV[1])
  local refillRate = tonumber(ARGV[2])
  local now = tonumber(ARGV[3])
  local cost = tonumber(ARGV[4])

  local bucket = redis.call('hmget', key, 'tokens', 'last_refill')
  local tokens = tonumber(bucket[1])
  local lastRefill = tonumber(bucket[2])

  -- First-time initialisation: fill the bucket to capacity
  if tokens == nil then
    tokens = capacity
    lastRefill = now
  else
    -- Refill: add (elapsed_seconds * refillRate) tokens, capped at capacity
    local elapsed = (now - lastRefill) / 1000
    if elapsed > 0 then
      tokens = math.min(capacity, tokens + elapsed * refillRate)
      lastRefill = now
    end
  end

  local allowed = 0
  if tokens >= cost then
    allowed = 1
    tokens = tokens - cost
  end

  -- Persist the updated bucket state
  redis.call('hmset', key, 'tokens', tokens, 'last_refill', lastRefill)

  -- TTL: bucket drain time * 2 + 60s safety margin.
  local ttl = math.ceil((capacity / math.max(refillRate, 0.001)) * 2 + 60)
  redis.call('expire', key, ttl)

  -- Calculate next refill epoch seconds.
  -- When allowed: there is at least 1 token worth of capacity remaining, so
  --   the client can retry immediately (nextRefill = 0).
  -- When denied: time until tokens refill to >= cost (i.e. at least 1 token).
  local nextRefill
  if allowed == 1 then
    nextRefill = 0
  else
    local deficit = cost - tokens
    nextRefill = math.ceil(now / 1000) + math.max(0, deficit / math.max(refillRate, 0.001))
  end

  return {allowed, tokens, nextRefill}
`;

/** Cache the Lua script SHA after loading it onto the Redis server. */
let _tokenBucketSha = null;

/**
 * Register the token bucket Lua script with Redis and cache its SHA.
 * Once cached, subsequent calls use EVALSHA instead of EVAL.
 */
async function _ensureScriptLoaded(redisClient) {
  if (_tokenBucketSha) return _tokenBucketSha;
  _tokenBucketSha = await redisClient.script("LOAD", TOKEN_BUCKET_LUA);
  return _tokenBucketSha;
}

/**
 * Token bucket rate-limit check using Redis and an atomic Lua script.
 *
 * The token bucket algorithm provides burst tolerance: up to `capacity`
 * requests can pass through in a short burst, and tokens refill at
 * `refillRate` per second thereafter.
 *
 * @param {string}  key        Redis key (e.g. "ratelimit:tb:1.2.3.4:GET:/api/analytics")
 * @param {number}  capacity   Maximum burst size (max tokens the bucket can hold)
 * @param {number}  refillRate Tokens added per second
 * @returns {Promise<{ allowed: boolean, remaining: number, limit: number, nextRefill: number }>}
 */
async function tokenBucketRateLimit(key, capacity, refillRate) {
  const now = Date.now();
  const cost = 1;
  const client = redisService.getClient();

  // Ensure the Lua script is cached on the Redis server
  await _ensureScriptLoaded(client);

  const result = await client.evalsha(
    _tokenBucketSha,
    1,             // number of keys
    key,
    String(capacity),
    String(refillRate),
    String(now),
    String(cost),
  );

  // evalsha returns [allowed, tokens_remaining, next_refill_seconds]
  const allowed = result[0] === 1;
  const remaining = Math.max(0, Math.floor(result[1]));
  const nextRefill = result[2];

  return {
    allowed,
    remaining,
    limit: capacity,
    nextRefill,
  };
}

/**
 * Per-endpoint Redis-backed rate limiter with dual-strategy support.
 *
 * Reads the rate limit config from rateLimitConfig.js based on the request's
 * method and path. Dispatches to the appropriate algorithm:
 *   - Sliding window (default): `{ points, duration }`
 *   - Token bucket: `{ strategy: "token-bucket", capacity, refillRate }`
 *
 * Sets standard rate-limit response headers, and rejects with HTTP 429 when
 * the limit is exceeded.
 *
 * When Redis is unreachable the middleware degrades gracefully to a no-op
 * (all requests pass through) so the API stays available during a cache
 * outage. In degraded mode a warning is emitted once per fallback event.
 *
 * @param {import("express").Request}  req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
async function redisRateLimiter(req, res, next) {
  const config = getRateLimitConfig(req.method, req.path);

  try {
    let allowed;
    if (config.strategy === "token-bucket") {
      allowed = await _handleTokenBucket(req, res, config);
    } else {
      allowed = await _handleSlidingWindow(req, res, config);
    }

    // Only continue to the route handler if the request was allowed through
    if (allowed) {
      next();
    }
  } catch (err) {
    // Redis unavailable — fall back to in-memory pass-through so the API
    // stays up during a cache outage or deployment transition.
    logger.warn(
      {
        event: "rate_limit_redis_fallback",
        err: err.message,
        ip: req.ip,
        path: req.path,
        method: req.method,
        strategy: config.strategy || "sliding-window",
      },
      "Redis unavailable for rate limiting — skipping check",
    );

    // In degraded mode we still set the header so clients see the
    // configured limit even though we can't enforce it.
    const limit = config.strategy === "token-bucket" ? config.capacity : config.points;
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(limit));

    next();
  }
}

/**
 * Handle a sliding-window rate limit check.
 * @returns {boolean} true if the request is allowed, false if rate-limited.
 */
async function _handleSlidingWindow(req, res, config) {
  const key = `ratelimit:sw:${req.ip}:${req.method}:${req.path}`;

  const result = await slidingWindowRateLimit(
    key,
    config.points,
    config.duration * 1000,
  );

  // ── Set standard rate-limit response headers ────────────────────────
  res.setHeader("X-RateLimit-Limit", String(config.points));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  res.setHeader("X-RateLimit-Reset", String(result.reset));

  // ── Update Prometheus gauge for remaining capacity ──────────────────
  rateLimitRemaining.set(
    { endpoint: req.path, strategy: "sliding-window" },
    result.remaining,
  );

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.reset));
    rateLimitHitsTotal.inc({ method: req.method, endpoint: req.path, strategy: "sliding-window" });

    (req.log || logger).warn(
      {
        event: "rate_limit_hit",
        strategy: "sliding-window",
        ip: req.ip,
        path: req.path,
        method: req.method,
        limit: config.points,
        windowSeconds: config.duration,
        remaining: result.remaining,
      },
      "Rate limit exceeded (Redis sliding window)",
    );

    sendAppError(res, "RATE_LIMITED", { retryAfter: result.reset });

    return false;
  }

  return true;
}

/**
 * Handle a token-bucket rate limit check.
 * @returns {boolean} true if the request is allowed, false if rate-limited.
 */
async function _handleTokenBucket(req, res, config) {
  const key = `ratelimit:tb:${req.ip}:${req.method}:${req.path}`;

  const result = await tokenBucketRateLimit(
    key,
    config.capacity,
    config.refillRate,
  );

  // ── Set standard rate-limit response headers ────────────────────────
  res.setHeader("X-RateLimit-Limit", String(config.capacity));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));
  res.setHeader("X-RateLimit-Reset", String(result.nextRefill));

  // ── Update Prometheus gauge for remaining capacity ──────────────────
  rateLimitRemaining.set(
    { endpoint: req.path, strategy: "token-bucket" },
    result.remaining,
  );

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.nextRefill));
    rateLimitHitsTotal.inc({ method: req.method, endpoint: req.path, strategy: "token-bucket" });

    (req.log || logger).warn(
      {
        event: "rate_limit_hit",
        strategy: "token-bucket",
        ip: req.ip,
        path: req.path,
        method: req.method,
        capacity: config.capacity,
        refillRate: config.refillRate,
        remaining: result.remaining,
      },
      "Rate limit exceeded (token bucket)",
    );

    sendAppError(res, "RATE_LIMITED", { retryAfter: result.nextRefill });

    return false;
  }

  return true;
}

// Testing hook: reset the cached Lua script SHA so that tests can verify
// fresh-loading behaviour from a clean module state.
/* c8 ignore next 4 */
if (process.env.NODE_ENV === "test" && process.env.JEST_WORKER_ID !== undefined) {
  module.exports._resetTokenBucketSha = () => { _tokenBucketSha = null; };
}

module.exports = {
  createRateLimiter,
  redisRateLimiter,
  slidingWindowRateLimit,
  tokenBucketRateLimit,
};