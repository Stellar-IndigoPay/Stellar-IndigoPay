/**
 * backend/src/middleware/cache.js
 *
 * Redis-backed response caching middleware with request coalescing
 * (cache stampede protection) and declarative invalidation.
 *
 * Exports:
 *   - cacheResponse(ttlSeconds, keyBuilder)  — Express middleware factory
 *   - invalidateCache(pattern)               — Delete cache keys by pattern
 *   - hashParams(params)                     — Deterministic param hasher
 */
"use strict";

const crypto = require("crypto");
const redis = require("../services/redis");
const logger = require("../logger");
const { cacheHits, cacheMisses, cacheCoalesced } = require("../services/metrics");

const inflightRequests = new Map();

function hashParams(params) {
  const sorted = {};
  Object.keys(params)
    .sort()
    .forEach((k) => {
      if (params[k] !== undefined && params[k] !== null) {
        sorted[k] = params[k];
      }
    });
  return crypto.createHash("md5").update(JSON.stringify(sorted)).digest("hex");
}

function cacheResponse(ttlSeconds, keyBuilder) {
  return async (req, res, next) => {
    const cacheKey = keyBuilder(req);
    const routeLabel = req.route ? `${req.method} ${req.baseUrl || ""}${req.route.path || ""}` : "unknown";

    try {
      const cached = await redis.get(cacheKey);
      if (cached !== null) {
        res.setHeader("X-Cache", "HIT");
        res.setHeader("Cache-Control", `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`);
        cacheHits.inc({ route: routeLabel });
        return res.json(cached);
      }
    } catch (err) {
      logger.warn({ cacheKey, err: err.message }, "Cache read failed — falling through to handler");
    }

    const inflight = inflightRequests.get(cacheKey);
    if (inflight) {
      res.setHeader("X-Cache", "COALESCED");
      res.setHeader("Cache-Control", `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`);
      cacheCoalesced.inc();
      try {
        const result = await inflight;
        return res.json(result);
      } catch (err) {
        return next(err);
      }
    }

    cacheMisses.inc({ route: routeLabel });

    const originalJson = res.json.bind(res);
    let resolvePromise;
    let rejectPromise;
    const computePromise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    inflightRequests.set(cacheKey, computePromise);

    let settled = false;

    res.json = function (body) {
      settled = true;
      redis.set(cacheKey, body, ttlSeconds).catch((err) => {
        logger.warn({ cacheKey, err: err.message }, "Failed to cache response");
      });

      res.setHeader("X-Cache", "MISS");
      res.setHeader("Cache-Control", `public, max-age=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`);

      inflightRequests.delete(cacheKey);
      resolvePromise(body);

      return originalJson(body);
    };

    res.on("close", () => {
      if (!settled && inflightRequests.has(cacheKey)) {
        inflightRequests.delete(cacheKey);
        const err = new Error("Request aborted before response completed");
        rejectPromise(err);
      }
    });

    next();
  };
}

async function invalidateCache(pattern) {
  try {
    await redis.deletePattern(pattern);
  } catch (err) {
    logger.warn({ pattern, err: err.message }, "Cache invalidation failed");
  }
}

module.exports = { cacheResponse, invalidateCache, hashParams };
