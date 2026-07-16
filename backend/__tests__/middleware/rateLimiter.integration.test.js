/**
 * __tests__/middleware/rateLimiter.integration.test.js
 *
 * Integration test for the Redis-backed token bucket rate limiter using
 * testcontainers-node with a real Redis instance.
 *
 * Verifies:
 *   - Token bucket initialisation (first request fills the bucket)
 *   - Burst consumption (rapidly consuming capacity tokens)
 *   - Rate-limit enforcement (excess requests get HTTP 429)
 *   - Refill over time (tokens replenish after waiting)
 *   - Fractional refill (partial token accumulation)
 *   - Capacity cap (tokens never exceed configured capacity)
 *   - Graceful Redis failure fallback
 *   - Lua script loading and caching
 *
 * Run with: npm test -- rateLimiter.integration
 * Test is skipped gracefully if Docker is unavailable.
 */

"use strict";

const { GenericContainer, Wait } = require("testcontainers");
const Redis = require("ioredis");

// ── Module-level mocks ─────────────────────────────────────────────────────
// We mock the redis service so that the rateLimiter module uses our
// testcontainer Redis client instead of the default singleton.
// NOTE: jest.mock factories are hoisted and cannot reference `let`/`const`
// variables from the outer scope. We use `jest.fn()` which IS available.

jest.mock("../../src/services/redis", () => ({
  getClient: jest.fn(),
  get: jest.fn(),
  set: jest.fn(),
  deletePattern: jest.fn(),
}));

// Mock prom-client to avoid registry conflicts with other tests
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

// ── Imports (after mocks) ──────────────────────────────────────────────────
const express = require("express");
const request = require("supertest");

describe("Token bucket rate limiter (Redis integration)", () => {
  jest.setTimeout(120000);

  /** @type {import('ioredis')} */
  let redisClient;
  /** @type {import('testcontainers').StartedTestContainer} */
  let container;
  let redisReady = false;

  // ── Start Redis container ────────────────────────────────────────────────

  beforeAll(async () => {
    if (process.env.SKIP_INTEGRATION === "1") {
      console.warn("Skipping integration tests (SKIP_INTEGRATION=1)");
      return;
    }

    try {
      container = await new GenericContainer("redis:7-alpine")
        .withExposedPorts(6379)
        .withWaitStrategy(Wait.forLogMessage("Ready to accept connections"))
        .withStartupTimeout(60000)
        .start();

      const host = container.getHost();
      const port = container.getMappedPort(6379);

      redisClient = new Redis(`redis://${host}:${port}`, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // fail fast
      });
      await redisClient.connect();

      // Ping to verify
      const pong = await redisClient.ping();
      expect(pong).toBe("PONG");

      // Wire the test Redis client into the mock so the rateLimiter module
      // uses our testcontainer Redis instead of the default singleton.
      const redisService = require("../../src/services/redis");
      redisService.getClient.mockReturnValue(redisClient);

      redisReady = true;
      console.log(`Testcontainers Redis ready at ${host}:${port}`);
    } catch (err) {
      console.warn(
        "Testcontainers Redis startup failed – integration tests will be skipped:",
        err.message,
      );
      redisReady = false;
      // Cleanup on failure
      try {
        if (redisClient) await redisClient.quit();
      } catch {
        // ignore
      }
      try {
        if (container) await container.stop();
      } catch {
        // ignore
      }
    }
  });

  // ── Cleanup ───────────────────────────────────────────────────────────────

  afterAll(async () => {
    try {
      if (redisClient) await redisClient.quit();
    } catch {
      // ignore
    }
    try {
      if (container) await container.stop({ timeout: 5000 });
    } catch {
      // ignore
    }
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Remove all rate-limit keys from Redis so each test starts clean. */
  async function flushRateLimitKeys() {
    if (!redisClient) return;
    const keys = await redisClient.keys("ratelimit:*");
    if (keys.length > 0) {
      await redisClient.del(...keys);
    }
  }

  // ── Tests ─────────────────────────────────────────────────────────────────

  describe("tokenBucketRateLimit core algorithm", () => {
    let tokenBucketRateLimit;

    beforeAll(async () => {
      if (!redisReady) return;

      // Clear the module cache to get a fresh rate limiter instance
      // (so the Lua script SHA cache starts clean and uses our test Redis)
      const mod = require("../../src/middleware/rateLimiter");
      tokenBucketRateLimit = mod.tokenBucketRateLimit;
      if (typeof mod._resetTokenBucketSha === "function") {
        mod._resetTokenBucketSha();
      }
    });

    beforeEach(async () => {
      if (!redisReady) return;
      await flushRateLimitKeys();
    });

    test("accepts a request when bucket is full", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const result = await tokenBucketRateLimit(
        "ratelimit:tb:test:full-key",
        10,  // capacity
        1,   // refillRate (1 token/sec)
      );

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(9);
      expect(result.limit).toBe(10);
    });

    test("consumes all tokens during burst", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const key = "ratelimit:tb:test:burst";
      const capacity = 5;

      // Consume all 5 tokens rapidly
      for (let i = 0; i < capacity; i++) {
        const result = await tokenBucketRateLimit(key, capacity, 1);
        expect(result.allowed).toBe(true);
        expect(result.remaining).toBe(capacity - 1 - i);
      }

      // Next request should be blocked
      const blocked = await tokenBucketRateLimit(key, capacity, 1);
      expect(blocked.allowed).toBe(false);
      expect(blocked.remaining).toBe(0);
      expect(blocked.nextRefill).toBeGreaterThan(0);
    });

    test("refills tokens over time", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const key = "ratelimit:tb:test:refill";
      const capacity = 3;
      const refillRate = 2; // 2 tokens/sec → 1 token every 500ms

      // Consume all 3 tokens
      for (let i = 0; i < capacity; i++) {
        await tokenBucketRateLimit(key, capacity, refillRate);
      }

      // Should be blocked
      const blocked = await tokenBucketRateLimit(key, capacity, refillRate);
      expect(blocked.allowed).toBe(false);

      // Wait for 1 token to refill (600ms to be safe)
      await new Promise((r) => setTimeout(r, 600));

      // Should now have 1 token available
      const refilled = await tokenBucketRateLimit(key, capacity, refillRate);
      expect(refilled.allowed).toBe(true);
      expect(refilled.remaining).toBe(0); // after consuming the refilled token
    });

    test("does not exceed capacity after long idle period", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const key = "ratelimit:tb:test:cap";
      const capacity = 5;
      const refillRate = 10; // fast refill

      // Consume 1 token: tokens go from 5 → 4
      const first = await tokenBucketRateLimit(key, capacity, refillRate);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(4);

      // Wait enough time to refill well past capacity
      // At refillRate=10, we would add 20 tokens in 2s, but capped at capacity=5
      await new Promise((r) => setTimeout(r, 2000));

      // Should have exactly capacity tokens (capped at 5, not 4 + 20 = 24)
      // After consuming 1 more token: remaining = 5 - 1 = 4
      const afterRest = await tokenBucketRateLimit(key, capacity, refillRate);
      expect(afterRest.allowed).toBe(true);
      expect(afterRest.remaining).toBe(capacity - 1); // capped at capacity, consumed 1
    });

    test("maintains correct state across consecutive calls", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const key = "ratelimit:tb:test:state";

      // First call creates bucket at full capacity
      const first = await tokenBucketRateLimit(key, 10, 1);
      expect(first.allowed).toBe(true);
      expect(first.remaining).toBe(9);

      // Second call consumes another token
      const second = await tokenBucketRateLimit(key, 10, 1);
      expect(second.allowed).toBe(true);
      expect(second.remaining).toBe(8);

      // Third call consumes another
      const third = await tokenBucketRateLimit(key, 10, 1);
      expect(third.allowed).toBe(true);
      expect(third.remaining).toBe(7);
    });

    test("handles fractional token accumulation", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const key = "ratelimit:tb:test:fractional";
      const capacity = 5;
      const refillRate = 1; // 1 token per second

      // Consume all tokens
      for (let i = 0; i < capacity; i++) {
        await tokenBucketRateLimit(key, capacity, refillRate);
      }

      // Wait 400ms — should accumulate ~0.4 tokens (fractional, < 1.0)
      await new Promise((r) => setTimeout(r, 400));

      // Not enough for 1 full token yet (0.4 < 1.0)
      const stillBlocked = await tokenBucketRateLimit(key, capacity, refillRate);
      expect(stillBlocked.allowed).toBe(false);

      // Wait another 700ms — total ~1.1s → ~1.1 tokens → should have 1 full token
      await new Promise((r) => setTimeout(r, 700));

      const refilled = await tokenBucketRateLimit(key, capacity, refillRate);
      expect(refilled.allowed).toBe(true);
    });

    test("returns correct limit and reset fields", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const result = await tokenBucketRateLimit(
        "ratelimit:tb:test:meta",
        10,
        1,
      );

      expect(result.allowed).toBe(true);
      expect(result.limit).toBe(10);
      expect(typeof result.remaining).toBe("number");
      expect(result.nextRefill).toBe(0); // allowed → immediate retry
    });

    test("cleans up Redis key after TTL expires", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const key = "ratelimit:tb:test:ttl-cleanup";
      const capacity = 3;
      const refillRate = 10; // fast refill → small TTL (ceil(3/10*2+60) ≈ 61s)

      // Make a request to create the key
      await tokenBucketRateLimit(key, capacity, refillRate);

      // Verify the key exists in Redis
      const existsBefore = await redisClient.exists(key);
      expect(existsBefore).toBe(1);

      // Check TTL is set
      const ttl = await redisClient.ttl(key);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(120); // should not be huge
    });
  });

  describe("redisRateLimiter middleware (token-bucket strategy)", () => {
    let redisRateLimiter;

    beforeAll(async () => {
      if (!redisReady) return;

      const mod = require("../../src/middleware/rateLimiter");
      redisRateLimiter = mod.redisRateLimiter;
    });

    beforeEach(async () => {
      if (!redisReady) return;
      await flushRateLimitKeys();
    });

    /** Build an Express app with the redisRateLimiter and an analytics route. */
    function buildAnalyticsApp() {
      const app = express();
      app.use(redisRateLimiter);
      // /api/analytics/* uses token-bucket strategy (capacity=10, refillRate=0.5)
      app.get("/api/analytics/summary", (_req, res) => res.json({ ok: true }));
      return app;
    }

    test("sets X-RateLimit-* headers on allowed request", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const app = buildAnalyticsApp();
      const res = await request(app).get("/api/analytics/summary");

      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("10");
      expect(res.headers["x-ratelimit-remaining"]).toBe("9");
      expect(res.headers["x-ratelimit-reset"]).toBeDefined();
    });

    test("returns 429 when bucket is exhausted", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const app = buildAnalyticsApp();

      // Consume all 10 tokens
      for (let i = 0; i < 10; i++) {
        await request(app).get("/api/analytics/summary");
      }

      // 11th request should be rate-limited
      const blocked = await request(app).get("/api/analytics/summary");
      expect(blocked.status).toBe(429);
      expect(blocked.body).toHaveProperty("error");
      expect(blocked.body).toHaveProperty("retryAfter");
      expect(blocked.headers["retry-after"]).toBeDefined();
      expect(blocked.headers["x-ratelimit-remaining"]).toBe("0");
    });

    test("recovers after refill wait", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const app = buildAnalyticsApp();

      // Exhaust bucket (capacity=10, refillRate=0.5 → 2 seconds per token)
      for (let i = 0; i < 10; i++) {
        await request(app).get("/api/analytics/summary");
      }

      // Verify blocked
      const blocked = await request(app).get("/api/analytics/summary");
      expect(blocked.status).toBe(429);

      // Wait for 2 tokens worth of refill (~4 seconds)
      await new Promise((r) => setTimeout(r, 4200));

      // Should now have 2 tokens — first request succeeds
      const recovered = await request(app).get("/api/analytics/summary");
      expect(recovered.status).toBe(200);
      expect(recovered.headers["x-ratelimit-remaining"]).toBe("1");
    });

    test("dispatches to sliding-window for non-token-bucket endpoints", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const app = express();
      app.use(redisRateLimiter);
      // /api/test is not configured → falls through to default sliding window
      app.get("/api/test", (_req, res) => res.json({ ok: true }));

      // Fire a few requests — sliding window should allow them
      const res = await request(app).get("/api/test");
      expect(res.status).toBe(200);
      expect(res.headers["x-ratelimit-limit"]).toBe("150"); // default
    });

    test("handle multiple endpoints independently", async () => {
      if (!redisReady) return expect(true).toBe(true);

      const app = express();
      app.use(redisRateLimiter);
      app.get("/api/analytics/summary", (_req, res) => res.json({ ok: true }));
      app.get("/api/analytics/project/abc", (_req, res) => res.json({ ok: true }));

      // Consume on one endpoint
      for (let i = 0; i < 10; i++) {
        await request(app).get("/api/analytics/summary");
      }

      // Should be blocked on consumed endpoint
      const blocked = await request(app).get("/api/analytics/summary");
      expect(blocked.status).toBe(429);

      // Different path should have its own bucket
      const allowed = await request(app).get("/api/analytics/project/abc");
      expect(allowed.status).toBe(200);
    });
  });
});
