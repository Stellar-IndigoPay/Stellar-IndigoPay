/**
 * src/middleware/cache.test.js
 * Unit tests for the Redis-backed response caching middleware.
 */
"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../services/redis");
jest.mock("../services/metrics", () => {
  return {
    cacheHits: { inc: jest.fn() },
    cacheMisses: { inc: jest.fn() },
    cacheCoalesced: { inc: jest.fn() },
  };
});
jest.mock("../logger", () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const redis = require("../services/redis");
const { cacheResponse, invalidateCache, hashParams } = require("./cache");

function buildApp(ttlSeconds, keyBuilder, handler) {
  const app = express();
  app.use(express.json());
  app.get("/test", cacheResponse(ttlSeconds, keyBuilder), handler || ((req, res) => {
    res.json({ data: "original", ts: Date.now() });
  }));
  return app;
}

describe("hashParams", () => {
  it("produces deterministic hashes for identical params", () => {
    const a = hashParams({ b: "2", a: "1" });
    const b = hashParams({ a: "1", b: "2" });
    expect(a).toBe(b);
  });

  it("produces different hashes for different params", () => {
    const a = hashParams({ a: "1" });
    const b = hashParams({ a: "2" });
    expect(a).not.toBe(b);
  });

  it("excludes undefined and null values", () => {
    const a = hashParams({ a: "1", b: undefined, c: null });
    const b = hashParams({ a: "1" });
    expect(a).toBe(b);
  });
});

describe("cacheResponse middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("serves cached response on cache hit with X-Cache: HIT header", async () => {
    const cachedBody = { data: "cached" };
    redis.get.mockResolvedValue(cachedBody);

    const app = buildApp(60, () => "cache:v1:test:key");
    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(cachedBody);
    expect(res.headers["x-cache"]).toBe("HIT");
    expect(res.headers["cache-control"]).toMatch(/public,\s*max-age=60/);
  });

  it("computes fresh response on cache miss with X-Cache: MISS header", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);

    const app = buildApp(120, () => "cache:v1:test:key", (req, res) => {
      res.json({ data: "fresh" });
    });
    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: "fresh" });
    expect(res.headers["x-cache"]).toBe("MISS");
    expect(redis.set).toHaveBeenCalledWith("cache:v1:test:key", { data: "fresh" }, 120);
  });

  it("coalesces concurrent requests for the same key (X-Cache: COALESCED) and increments metric", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);
    const { cacheCoalesced } = require("../services/metrics");

    let handlerCallCount = 0;
    let resolveHandler;
    const handlerPromise = new Promise((resolve) => { resolveHandler = resolve; });
    let handlerEntryDone;
    const handlerEntry = new Promise((resolve) => { handlerEntryDone = resolve; });

    const app = express();
    app.use(express.json());
    app.get("/test", cacheResponse(60, () => "cache:v1:coalesce:test"), async (req, res) => {
      handlerCallCount++;
      handlerEntryDone();
      await handlerPromise;
      res.json({ data: "coalesced", ts: Date.now() });
    });

    const p1 = request(app).get("/test").then((r) => r);
    await handlerEntry;
    const p2 = request(app).get("/test").then((r) => r);

    setTimeout(() => resolveHandler(), 200);

    const [res1, res2] = await Promise.all([p1, p2]);

    expect(handlerCallCount).toBe(1);
    expect(res1.headers["x-cache"]).toBe("MISS");
    expect(res2.headers["x-cache"]).toBe("COALESCED");
    expect(res1.body).toEqual(res2.body);
    expect(cacheCoalesced.inc).toHaveBeenCalled();
  }, 10000);

  it("sets Cache-Control header with max-age and stale-while-revalidate", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);

    const app = buildApp(300, () => "cache:v1:test:cc");
    const res = await request(app).get("/test");

    expect(res.headers["cache-control"]).toBe("public, max-age=300, stale-while-revalidate=600");
  });

  it("falls through to handler when Redis get fails (graceful degradation)", async () => {
    redis.get.mockRejectedValue(new Error("Redis connection refused"));
    redis.set.mockResolvedValue(undefined);

    const app = buildApp(60, () => "cache:v1:fail:key", (req, res) => {
      res.json({ data: "fallback" });
    });
    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ data: "fallback" });
    const logger = require("../logger");
    expect(logger.warn).toHaveBeenCalled();
  });

  it("does not cache response when Redis set fails (non-fatal)", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockRejectedValue(new Error("SET failed"));

    const app = buildApp(60, () => "cache:v1:setfail:key", (req, res) => {
      res.json({ data: "ok" });
    });
    const res = await request(app).get("/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-cache"]).toBe("MISS");
    const logger = require("../logger");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ cacheKey: "cache:v1:setfail:key" }),
      "Failed to cache response",
    );
  });

  it("increments cacheHits metric on hit", async () => {
    redis.get.mockResolvedValue({ data: "cached" });
    const { cacheHits } = require("../services/metrics");

    const app = buildApp(60, () => "cache:v1:metric:hit");
    await request(app).get("/test");

    expect(cacheHits.inc).toHaveBeenCalledWith({ route: expect.any(String) });
  });

  it("increments cacheMisses metric on miss", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);
    const { cacheMisses } = require("../services/metrics");

    const app = buildApp(60, () => "cache:v1:metric:miss", (req, res) => {
      res.json({ data: "fresh" });
    });
    await request(app).get("/test");

    expect(cacheMisses.inc).toHaveBeenCalledWith({ route: expect.any(String) });
  });

  it("cleans up inflight promise on error", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.get("/test", cacheResponse(60, () => "cache:v1:error:key"), async (req, res, next) => {
      next(new Error("Handler error"));
    });
    app.use((err, req, res, _next) => {
      res.status(500).json({ error: err.message });
    });

    const res = await request(app).get("/test");
    expect(res.status).toBe(500);
  });
});

describe("invalidateCache", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls redis.deletePattern with the given pattern", async () => {
    redis.deletePattern.mockResolvedValue(undefined);

    await invalidateCache("cache:v1:projects:list:*");

    expect(redis.deletePattern).toHaveBeenCalledWith("cache:v1:projects:list:*");
  });

  it("handles Redis deletePattern failure gracefully", async () => {
    redis.deletePattern.mockRejectedValue(new Error("DEL failed"));

    await expect(invalidateCache("cache:v1:bad:pattern:*")).resolves.toBeUndefined();
    const logger = require("../logger");
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ pattern: "cache:v1:bad:pattern:*" }),
      "Cache invalidation failed",
    );
  });
});

describe("cache key builder integration", () => {
  it("builds project list cache key from query params excluding cursor", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.get("/projects", cacheResponse(120, (req) => {
      const params = { ...req.query };
      delete params.cursor;
      return `cache:v1:projects:list:${hashParams(params)}`;
    }), (req, res) => {
      res.json({ data: "projects" });
    });

    await request(app).get("/projects?category=Reforestation&status=active&cursor=abc123");
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^cache:v1:projects:list:/),
      { data: "projects" },
      120,
    );
  });

  it("builds leaderboard cache key from query params", async () => {
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(undefined);

    const app = express();
    app.use(express.json());
    app.get("/leaderboard", cacheResponse(60, (req) => {
      return `cache:v1:leaderboard:${require("crypto").createHash("md5").update(JSON.stringify(req.query)).digest("hex")}`;
    }), (req, res) => {
      res.json({ data: "leaderboard" });
    });

    await request(app).get("/leaderboard?period=month&limit=10");
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringMatching(/^cache:v1:leaderboard:/),
      { data: "leaderboard" },
      60,
    );
  });
});
