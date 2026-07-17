/**
 * __tests__/middleware/rateLimiter.test.js
 *
 * Unit tests for the Redis-backed sliding window rate limiter.
 *
 * Coverage:
 *   - slidingWindowRateLimit: allows under limit, blocks over limit
 *   - redisRateLimiter: headers set correctly, 429 on over-limit
 *   - Redis failure fallback (no-op pass-through)
 *   - rateLimitConfig: pattern matching, wildcards, defaults
 *   - Legacy createRateLimiter (backward compat integration)
 */

"use strict";

// ── Mocks ───────────────────────────────────────────────────────────────────
// IMPORTANT: jest.mock factories must NOT reference out-of-scope variables
// (Jest hoists them). All mock setup happens inline inside the factory.

jest.mock("prom-client", () => {
  const mockSet = jest.fn();
  const mockInc = jest.fn();
  return {
    Gauge: jest.fn(() => ({ set: mockSet })),
    Counter: jest.fn(() => ({ inc: mockInc })),
    Histogram: jest.fn(() => ({ observe: jest.fn() })),
    Registry: jest.fn().mockImplementation(() => ({
      registerMetric: jest.fn(),
      metrics: jest.fn().mockResolvedValue(""),
      contentType: "text/plain",
      setDefaultLabels: jest.fn(),
    })),
    collectDefaultMetrics: jest.fn(),
  };
});

jest.mock("../../src/services/redis", () => ({
  getClient: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  deletePattern: jest.fn(),
}));

jest.mock("../../src/services/metrics", () => ({
  registry: {
    registerMetric: jest.fn(),
    metrics: jest.fn().mockResolvedValue(""),
    contentType: "text/plain",
    setDefaultLabels: jest.fn(),
  },
  normaliseRoute: jest.fn(),
  refreshDbPoolMetrics: jest.fn(),
  refreshQueueMetrics: jest.fn(),
  metrics: {},
}));

jest.mock("express-rate-limit", () => {
  const mockMiddleware = jest.fn((options) => {
    const fn = (req, res, next) => {
      if (!fn._counter) fn._counter = { count: 0 };
      fn._counter.count += 1;
      if (fn._counter.count > options.max) {
        res.set("Retry-After", Math.ceil((options.windowMs || 60000) / 1000));
        return options.handler
          ? options.handler(req, res)
          : res.status(429).json({ message: "Too many requests" });
      }
      res.set("X-RateLimit-Limit", options.max);
      next();
    };
    fn._options = options;
    return fn;
  });
  return mockMiddleware;
});

// ── Module imports (after mocks are set up) ────────────────────────────────
const express = require("express");
const request = require("supertest");
const redisService = require("../../src/services/redis");

// ── Shared helpers ─────────────────────────────────────────────────────────

/**
 * Create a mock pipeline with controllable `exec` behaviour.
 * Each call to `mockPipelineExec` returns the next resolved value.
 */
function createMockPipeline() {
  const mockPipelineExec = jest.fn();
  const mockPipelineObj = {
    zadd: jest.fn().mockReturnThis(),
    zremrangebyscore: jest.fn().mockReturnThis(),
    zcard: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: mockPipelineExec,
  };
  return mockPipelineObj;
}

/** Set a single resolved value for pipeline.exec(). */
function mockPipelineExec(mockPipelineObj, resolvedValue) {
  mockPipelineObj.exec.mockResolvedValueOnce(resolvedValue);
}

/** Set pipeline.exec() to reject (simulate Redis failure). */
function mockPipelineReject(mockPipelineObj) {
  mockPipelineObj.exec.mockRejectedValueOnce(new Error("Redis connection refused"));
}

/** Build a fresh pipeline mock, wire it into redis.getClient, return the pipeline. */
function setupMockPipeline() {
  const pipeline = createMockPipeline();
  redisService.getClient.mockReturnValue({
    pipeline: jest.fn().mockReturnValue(pipeline),
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(),
    quit: jest.fn().mockResolvedValue(),
  });
  return pipeline;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("getRateLimitConfig", () => {
  let getRateLimitConfig;

  beforeAll(() => {
    getRateLimitConfig = require("../../src/middleware/rateLimitConfig").getRateLimitConfig;
  });

  test("returns donation config for POST /api/donations", () => {
    const config = getRateLimitConfig("POST", "/api/donations");
    expect(config.points).toBe(10);
    expect(config.duration).toBe(60);
  });

  test("returns verification config for POST /api/verification-requests", () => {
    const config = getRateLimitConfig("POST", "/api/verification-requests");
    expect(config.points).toBe(10);
    expect(config.duration).toBe(900);
  });

  test("returns default config for unmatched endpoints", () => {
    const config = getRateLimitConfig("GET", "/api/unknown-endpoint");
    expect(config.points).toBe(150);
    expect(config.duration).toBe(900);
  });

  test("matches wildcard for /api/admin/*", () => {
    const config = getRateLimitConfig("GET", "/api/admin/some-action");
    expect(config.points).toBe(30);
    expect(config.duration).toBe(60);
  });

  test("matches method-specific wildcard for POST /api/admin/*", () => {
    const config = getRateLimitConfig("POST", "/api/admin/delete-user");
    // POST /api/admin/* is 20 req/min in the config (more specific)
    expect(config.points).toBe(20);
    expect(config.duration).toBe(60);
  });

  test("returns projects GET config for read-heavy endpoints", () => {
    const config = getRateLimitConfig("GET", "/api/projects/abc-123");
    expect(config.points).toBe(100);
    expect(config.duration).toBe(60);
  });

  test("returns registration config for POST /api/projects", () => {
    const config = getRateLimitConfig("POST", "/api/projects");
    expect(config.points).toBe(5);
    expect(config.duration).toBe(60);
  });

  test("handles trailing slashes correctly", () => {
    const config = getRateLimitConfig("POST", "/api/donations/");
    expect(config.points).toBe(10);
  });

  test("matches impact wildcard", () => {
    const config = getRateLimitConfig("GET", "/api/impact/certificate/abc");
    expect(config.points).toBe(60);
    expect(config.duration).toBe(60);
  });

  test("matches nested path under POST /api/admin/* via any-method fallback", () => {
    // POST /api/admin/settings/users — step 2 wildcard replaces only last
    // segment → POST /api/admin/settings/* (not in config). Step 3 should
    // still match /api/admin/* (any-method) or POST /api/admin/*.
    const config = getRateLimitConfig("POST", "/api/admin/settings/users");
    // Should match POST /api/admin/* (20 req/min) via step 3 iteration
    expect(config.points).toBe(20);
    expect(config.duration).toBe(60);
  });

  test("default for truly unmatched patterns", () => {
    const config = getRateLimitConfig("DELETE", "/api/unknown");
    expect(config.points).toBe(150);
  });
});

describe("slidingWindowRateLimit", () => {
  let slidingWindowRateLimit;

  beforeAll(() => {
    slidingWindowRateLimit = require("../../src/middleware/rateLimiter").slidingWindowRateLimit;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("allows requests under the limit", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 3],
      [null, 5],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:key", 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
    expect(result.limit).toBe(10);
    expect(typeof result.reset).toBe("number");
  });

  test("rejects requests over the limit", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 12],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:over", 10, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  test("returns correct remaining when exactly at limit", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 10],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:exact", 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  test("returns full capacity when no requests have been made", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 0],
      [null, 1],
    ]);

    const result = await slidingWindowRateLimit("test:empty", 10, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(10);
  });

  test("Uses pipeline for Redis commands", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 3],
      [null, 1],
    ]);

    await slidingWindowRateLimit("test:pipeline", 10, 60_000);
    expect(pipeline.zadd).toHaveBeenCalled();
    expect(pipeline.zremrangebyscore).toHaveBeenCalled();
    expect(pipeline.zcard).toHaveBeenCalled();
    expect(pipeline.expire).toHaveBeenCalled();
    expect(pipeline.exec).toHaveBeenCalled();
  });
});

describe("redisRateLimiter middleware", () => {
  let redisRateLimiter;
  let app;

  beforeAll(() => {
    redisRateLimiter = require("../../src/middleware/rateLimiter").redisRateLimiter;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use(redisRateLimiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));
    app.post("/api/donations", (_req, res) => res.json({ ok: true }));
    return app;
  }

  test("sets X-RateLimit-* headers on allowed requests", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 3],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app).get("/api/test");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  test("returns 429 when over the limit", async () => {
    const pipeline = setupMockPipeline();
    // /api/test is not a known endpoint, so default config applies (150 req / 900s)
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 151],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app).get("/api/test");

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error).toHaveProperty("retryAfter");
    expect(res.headers["retry-after"]).toBeDefined();
  });

  test("returns 200 under limit for POST /api/donations", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 5],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app)
      .post("/api/donations")
      .send({});

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("10");
  });

  test("returns 429 on 11th POST /api/donations (11 > limit 10)", async () => {
    const pipeline = setupMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 11],
      [null, 1],
    ]);

    app = buildApp();
    const res = await request(app)
      .post("/api/donations")
      .send({});

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error).toHaveProperty("retryAfter");
  });
});

describe("Redis failure fallback", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("allows the request through when Redis is unavailable", async () => {
    const { redisRateLimiter } = require("../../src/middleware/rateLimiter");
    const pipeline = setupMockPipeline();
    mockPipelineReject(pipeline);

    app = express();
    app.use(redisRateLimiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
  });

  test("still sets X-RateLimit headers in degraded mode", async () => {
    const { redisRateLimiter } = require("../../src/middleware/rateLimiter");
    const pipeline = setupMockPipeline();
    mockPipelineReject(pipeline);

    app = express();
    app.use(redisRateLimiter);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/test");
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
  });
});

// ── Token bucket tests ─────────────────────────────────────────────────────

describe("getRateLimitConfig — token-bucket strategy", () => {
  let getRateLimitConfig;

  beforeAll(() => {
    getRateLimitConfig = require("../../src/middleware/rateLimitConfig").getRateLimitConfig;
  });

  test("returns token-bucket config for GET /api/analytics/*", () => {
    const config = getRateLimitConfig("GET", "/api/analytics/summary");
    expect(config.strategy).toBe("token-bucket");
    expect(config.capacity).toBe(10);
    expect(config.refillRate).toBe(0.5);
  });

  test("returns token-bucket config for nested analytics paths", () => {
    const config = getRateLimitConfig("GET", "/api/analytics/project/abc-123/donations");
    expect(config.strategy).toBe("token-bucket");
    expect(config.capacity).toBe(10);
  });

  test("returns sliding-window config (no strategy) for default endpoints", () => {
    const config = getRateLimitConfig("POST", "/api/donations");
    expect(config.strategy).toBeUndefined();
    expect(config.points).toBe(10);
  });

  test("returns default sliding-window config for unmatched paths", () => {
    const config = getRateLimitConfig("GET", "/api/unknown");
    expect(config.strategy).toBeUndefined();
    expect(config.points).toBe(150);
  });
});

describe("tokenBucketRateLimit", () => {
  let tokenBucketRateLimit;

  beforeAll(() => {
    const mod = require("../../src/middleware/rateLimiter");
    tokenBucketRateLimit = mod.tokenBucketRateLimit;
    // Reset the module-scoped SHA cache so script-loading tests start clean
    if (typeof mod._resetTokenBucketSha === "function") {
      mod._resetTokenBucketSha();
    }
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Create a mock Redis client that supports `script("LOAD", ...)` and
   * `evalsha(sha, numKeys, ...)`. The evalsha mock resolves to the
   * provided Lua return value array: [allowed, tokens, nextRefill].
   */
  function setupMockRedisForTokenBucket(evalshaResult) {
    const mockClient = {
      script: jest.fn().mockResolvedValue("mock-sha"),
      evalsha: jest.fn().mockResolvedValue(evalshaResult),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(),
      quit: jest.fn().mockResolvedValue(),
    };
    redisService.getClient.mockReturnValue(mockClient);
    return mockClient;
  }

  test("loads the Lua script on first invocation", async () => {
    const client = setupMockRedisForTokenBucket([1, 9, 0]);

    await tokenBucketRateLimit("ratelimit:tb:test:lua-load", 10, 1);

    expect(client.script).toHaveBeenCalledWith("LOAD", expect.stringContaining("token"));
    expect(client.evalsha).toHaveBeenCalled();
  });

  test("caches the Lua script SHA for subsequent invocations", async () => {
    // Use jest.isolateModules to get a fresh module with null _tokenBucketSha
    let freshTokenBucket;
    jest.isolateModules(() => {
      freshTokenBucket = require("../../src/middleware/rateLimiter").tokenBucketRateLimit;
    });

    const client = setupMockRedisForTokenBucket([1, 9, 0]);

    // First call should load the script
    await freshTokenBucket("ratelimit:tb:test:cache1", 10, 1);
    // Second call should reuse cached SHA without loading
    await freshTokenBucket("ratelimit:tb:test:cache2", 10, 1);

    // script should only be loaded once (first invocation)
    expect(client.script).toHaveBeenCalledTimes(1);
    // evalsha should be called for both requests
    expect(client.evalsha).toHaveBeenCalledTimes(2);
  });

  test("allows a request when bucket is full", async () => {
    setupMockRedisForTokenBucket([1, 9, 0]);  // allowed=1, remaining=9, nextRefill=0

    const result = await tokenBucketRateLimit("ratelimit:tb:test:key", 10, 1);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
    expect(result.limit).toBe(10);
    expect(result.nextRefill).toBe(0);
  });

  test("allows burst up to capacity", async () => {
    setupMockRedisForTokenBucket([1, 0, 0]);  // allowed=1, remaining=0 (last one used)

    const result = await tokenBucketRateLimit("ratelimit:tb:test:burst", 10, 1);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });

  test("rejects request when bucket is empty", async () => {
    setupMockRedisForTokenBucket([0, 0, 1742169602]);  // allowed=0, remaining=0, nextRefill=epoch

    const result = await tokenBucketRateLimit("ratelimit:tb:test:empty", 10, 1);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.nextRefill).toBeGreaterThan(0);
  });

  test("handles fractional remaining tokens", async () => {
    setupMockRedisForTokenBucket([1, 0.3, 0]);  // allowed=1, remaining=0.3 fractional

    const result = await tokenBucketRateLimit("ratelimit:tb:test:fractional", 10, 1);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);  // Math.floor(0.3) = 0
  });

  test("uses evalsha with correct arguments", async () => {
    const client = setupMockRedisForTokenBucket([1, 5, 0]);

    await tokenBucketRateLimit("ratelimit:tb:test:args", 20, 0.5);

    expect(client.evalsha).toHaveBeenCalledWith(
      "mock-sha",
      1,                    // number of keys
      "ratelimit:tb:test:args",
      "20",                 // capacity as string
      "0.5",                // refillRate as string
      expect.any(String),   // now timestamp
      "1",                  // cost
    );
  });
});

describe("redisRateLimiter with token-bucket strategy", () => {
  let redisRateLimiter;
  let app;

  beforeAll(() => {
    redisRateLimiter = require("../../src/middleware/rateLimiter").redisRateLimiter;
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** Create a mock Redis + Lua client for token-bucket middleware tests. */
  function setupTokenBucketMockRedis(evalshaResult) {
    const mockClient = {
      script: jest.fn().mockResolvedValue("mock-sha"),
      evalsha: jest.fn().mockResolvedValue(evalshaResult),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(),
      quit: jest.fn().mockResolvedValue(),
    };
    redisService.getClient.mockReturnValue(mockClient);
    return mockClient;
  }

  /** Build an Express app with the redisRateLimiter and analytics endpoints. */
  function buildAnalyticsApp() {
    const app = express();
    app.use(express.json());
    app.use(redisRateLimiter);
    // /api/analytics/* uses the token-bucket strategy in config
    app.get("/api/analytics/summary", (_req, res) => res.json({ ok: true }));
    app.get("/api/analytics/project/abc", (_req, res) => res.json({ ok: true }));
    return app;
  }

  test("sets X-RateLimit-* headers for token-bucket allowed request", async () => {
    setupTokenBucketMockRedis([1, 7, 0]);

    app = buildAnalyticsApp();
    const res = await request(app).get("/api/analytics/summary");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBe("10");   // capacity
    expect(res.headers["x-ratelimit-remaining"]).toBe("7");
    expect(res.headers["x-ratelimit-reset"]).toBeDefined();
  });

  test("returns 429 for token-bucket when bucket is empty", async () => {
    setupTokenBucketMockRedis([0, 0, Math.floor(Date.now() / 1000) + 10]);

    app = buildAnalyticsApp();
    const res = await request(app).get("/api/analytics/summary");

    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("RATE_LIMITED");
    expect(res.body.error).toHaveProperty("retryAfter");
    expect(res.headers["retry-after"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBe("0");
  });

  test("dispatches to sliding-window for non-token-bucket endpoints", async () => {
    // For sliding window we need a pipeline, not evalsha
    const pipeline = createMockPipeline();
    mockPipelineExec(pipeline, [
      [null, "ok"],
      [null, 0],
      [null, 3],
      [null, 1],
    ]);
    redisService.getClient.mockReturnValue({
      pipeline: jest.fn().mockReturnValue(pipeline),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(),
      quit: jest.fn().mockResolvedValue(),
    });

    // Build an app with non-token-bucket endpoint
    app = express();
    app.use(redisRateLimiter);
    app.get("/api/donations", (_req, res) => res.json({ ok: true }));

    const res = await request(app).get("/api/donations");

    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(pipeline.zadd).toHaveBeenCalled();  // sliding window was used
  });

  test("burst capacity allows rapid requests then blocks", async () => {
    // Simulate: first 10 requests allowed (burst full), 11th blocked
    let callCount = 0;
    const mockClient = {
      script: jest.fn().mockResolvedValue("mock-sha"),
      evalsha: jest.fn().mockImplementation(() => {
        callCount++;
        if (callCount <= 10) {
          // Allowed with decreasing remaining tokens
          return Promise.resolve([1, 10 - callCount, 0]);
        }
        // Blocked
        return Promise.resolve([0, 0, Math.floor(Date.now() / 1000) + 2]);
      }),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(),
      quit: jest.fn().mockResolvedValue(),
    };
    redisService.getClient.mockReturnValue(mockClient);

    app = buildAnalyticsApp();

    // First 10 requests should succeed (burst)
    for (let i = 0; i < 10; i++) {
      const res = await request(app).get("/api/analytics/summary");
      expect(res.status).toBe(200);
    }

    // 11th request should be blocked
    const blocked = await request(app).get("/api/analytics/summary");
    expect(blocked.status).toBe(429);
  });

  test("handles Redis failure gracefully for token-bucket endpoints", async () => {
    const mockClient = {
      script: jest.fn().mockRejectedValue(new Error("Redis connection refused")),
      evalsha: jest.fn().mockRejectedValue(new Error("Redis connection refused")),
      on: jest.fn(),
      connect: jest.fn().mockResolvedValue(),
      quit: jest.fn().mockResolvedValue(),
    };
    redisService.getClient.mockReturnValue(mockClient);

    app = buildAnalyticsApp();

    const res = await request(app).get("/api/analytics/summary");

    // Should fall through (degraded mode)
    expect(res.status).toBe(200);
    expect(res.headers["x-ratelimit-limit"]).toBeDefined();
    expect(res.headers["x-ratelimit-remaining"]).toBeDefined();
  });
});

describe("Legacy createRateLimiter (backward compat)", () => {
  let createRateLimiter;

  beforeAll(() => {
    createRateLimiter = require("../../src/middleware/rateLimiter").createRateLimiter;
  });

  function buildApp(maxRequests = 10, windowMinutes = 1) {
    const app = express();
    const limiter = createRateLimiter(maxRequests, windowMinutes);
    app.use(limiter);
    app.get("/ping", (_req, res) => res.status(200).json({ ok: true }));
    return app;
  }

  test("allows up to max requests within the window", async () => {
    const app = buildApp(5, 1);
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get("/ping");
      expect(res.status).toBe(200);
    }
  });

  test("blocks the (max+1)th request with 429", async () => {
    const app = buildApp(3, 1);
    for (let i = 0; i < 3; i++) await request(app).get("/ping");

    const res = await request(app).get("/ping");
    expect(res.status).toBe(429);
  });

  test("sets Retry-After header on 429", async () => {
    const app = buildApp(1, 1);
    await request(app).get("/ping");
    const res = await request(app).get("/ping");
    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeDefined();
  });
});
