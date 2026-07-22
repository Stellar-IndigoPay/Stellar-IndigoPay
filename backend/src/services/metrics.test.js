"use strict";

jest.mock("../logger", () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
}));

jest.mock("../db/pool", () => ({
  query: jest.fn().mockRejectedValue(new Error("pool not initialized")),
  getWriter: jest.fn(() => ({ query: jest.fn() })),
  _writerPool: { totalCount: 0, idleCount: 0, waitingCount: 0, max: 20 },
}));

const {
  registry,
  metrics,
  normaliseRoute,
  refreshDbPoolMetrics,
} = require("./metrics");

describe("metrics service", () => {
  test("registry exposes the standard process / nodejs metric prefix", async () => {
    const text = await registry.metrics();
    // `nodejs_` prefix is set by collectDefaultMetrics. We don't assert the
    // exact metric names (they shift between prom-client versions) — we
    // just verify the prefix is in there.
    expect(text).toMatch(/^# HELP nodejs_/m);
  });

  test("default service + env labels are set on every metric", async () => {
    const text = await registry.metrics();
    // Default labels are rendered as `service="stellar-indigopay-api"`.
    expect(text).toMatch(/service="stellar-indigopay-api"/);
  });

  test("http_requests_total counter increments on labels", async () => {
    metrics.httpRequestsTotal.inc(
      { method: "GET", route: "/api/projects", status_code: "200" },
      3,
    );
    const text = await registry.metrics();
    expect(text).toMatch(
      /http_requests_total\{[^}]*route="\/api\/projects"[^}]*status_code="200"[^}]*\} 3/,
    );
  });

  test("http_request_duration_seconds histogram observes a value", async () => {
    metrics.httpRequestDurationSeconds.observe(
      { method: "GET", route: "/api/health", status_code: "200" },
      0.123,
    );
    const text = await registry.metrics();
    // The histogram exposes _count, _sum, and _bucket{le=...} series.
    expect(text).toMatch(
      /http_request_duration_seconds_count\{[^}]*route="\/api\/health"[^}]*\}/,
    );
  });

  test("normaliseRoute returns the matched route pattern when req.route is set", () => {
    const req = { baseUrl: "/api", route: { path: "/:id" } };
    expect(normaliseRoute(req)).toBe("/api/:id");
  });

  test("normaliseRoute collapses long paths to /<a>/<b>/:rest to bound cardinality", () => {
    const req = { path: "/api/projects/abc-123/donations" };
    expect(normaliseRoute(req)).toBe("/api/projects/:rest");
  });

  test("normaliseRoute keeps short paths verbatim", () => {
    const req = { path: "/api/health" };
    expect(normaliseRoute(req)).toBe("/api/health");
  });

  test("refreshDbPoolMetrics is a no-op when the pool is undefined", () => {
    expect(() => refreshDbPoolMetrics(undefined)).not.toThrow();
  });

  test("refreshDbPoolMetrics reads the live counts from a real pool-shaped object", () => {
    const fakePool = { totalCount: 12, idleCount: 8, waitingCount: 2, max: 20 };
    refreshDbPoolMetrics(fakePool);
    const text = require("./metrics").registry.metrics();
    // Synchronously call .then because registry.metrics is async, but the
    // gauge values are set synchronously.
    return text.then((body) => {
      expect(body).toMatch(/db_pool_total_count\{[^}]*\} 12/);
      expect(body).toMatch(/db_pool_idle_count\{[^}]*\} 8/);
      expect(body).toMatch(/db_pool_waiting_count\{[^}]*\} 2/);
    });
  });

  test("refreshDbPoolMetrics sets utilization ratio", () => {
    const fakePool = { totalCount: 10, idleCount: 5, waitingCount: 1, max: 20 };
    refreshDbPoolMetrics(fakePool);
    const text = require("./metrics").registry.metrics();
    return text.then((body) => {
      expect(body).toMatch(/db_pool_utilization_ratio\{[^}]*\} 0.5/);
    });
  });

  test("db_slow_queries_total and db_connection_errors_total are registered", () => {
    const { metrics } = require("./metrics");
    expect(metrics.dbSlowQueriesTotal).toBeDefined();
    expect(metrics.dbConnectionErrorsTotal).toBeDefined();
    expect(metrics.dbSlowQueriesTotal).toHaveProperty("inc");
    expect(metrics.dbConnectionErrorsTotal).toHaveProperty("inc");
  });

  test("refreshDbPoolMetrics logs warning when waitingCount > 0", () => {
    const logger = require("../logger");
    const fakePool = { totalCount: 15, idleCount: 5, waitingCount: 2, max: 20 };
    refreshDbPoolMetrics(fakePool);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "db_pool_contention", waitingCount: 2 }),
      expect.any(String),
    );
  });

  test("refreshDbPoolMetrics logs error when waitingCount > 5", () => {
    const logger = require("../logger");
    const fakePool = { totalCount: 18, idleCount: 2, waitingCount: 6, max: 20 };
    refreshDbPoolMetrics(fakePool);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: "db_pool_high_contention", waitingCount: 6 }),
      expect.any(String),
    );
  });

  test("refreshDbPoolMetrics logs warning when utilization >= 90%", () => {
    const logger = require("../logger");
    const fakePool = { totalCount: 18, idleCount: 1, waitingCount: 3, max: 20 };
    refreshDbPoolMetrics(fakePool);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: "db_pool_high_utilization", utilizationRatio: 0.9 }),
      expect.any(String),
    );
  });

  test("registry.contentType is the Prometheus text format", () => {
    expect(registry.contentType).toMatch(/text\/plain/);
  });
});

describe("dbPoolMax gauge", () => {
  test("refreshDbPoolMetrics sets db_pool_max from pool.max", () => {
    const fakePool = { totalCount: 5, idleCount: 3, waitingCount: 0, max: 20 };
    refreshDbPoolMetrics(fakePool);
    const text = require("./metrics").registry.metrics();
    return text.then((body) => {
      expect(body).toMatch(/db_pool_max\{[^}]*\} 20/);
    });
  });

  test("refreshDbPoolMetrics sets db_pool_max from pool.options.max as fallback", () => {
    const fakePool = {
      totalCount: 2,
      idleCount: 1,
      waitingCount: 0,
      max: undefined,
      options: { max: 15 },
    };
    refreshDbPoolMetrics(fakePool);
    const text = require("./metrics").registry.metrics();
    return text.then((body) => {
      expect(body).toMatch(/db_pool_max\{[^}]*\} 15/);
    });
  });

  test("refreshDbPoolMetrics defaults db_pool_max to 1 when both are missing", () => {
    const fakePool = {
      totalCount: 0,
      idleCount: 0,
      waitingCount: 0,
      max: undefined,
      options: {},
    };
    refreshDbPoolMetrics(fakePool);
    const text = require("./metrics").registry.metrics();
    return text.then((body) => {
      expect(body).toMatch(/db_pool_max\{[^}]*\} 1/);
    });
  });
});

describe("adaptive pool sizing", () => {
  let logger;

  beforeEach(() => {
    logger = require("../logger");
    logger.info.mockClear();
    logger.warn.mockClear();
    logger.error.mockClear();
  });

  test("increases pool max after 4 consecutive saturated checks", () => {
    const pool = { totalCount: 20, idleCount: 0, waitingCount: 2, max: 20, options: { max: 20 } };

    // 3 consecutive saturated checks — no resize yet
    for (let i = 0; i < 3; i++) {
      refreshDbPoolMetrics(pool);
    }
    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "adaptive_pool_sizing" }),
      expect.any(String),
    );
    expect(pool.options.max).toBe(20);

    // 4th check triggers resize (20 → 25)
    refreshDbPoolMetrics(pool);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "adaptive_pool_sizing",
        oldMax: 20,
        newMax: 25,
        waitingCount: 2,
      }),
      expect.any(String),
    );
    expect(pool.options.max).toBe(25);
  });

  test("does not increase when not saturated (total < max)", () => {
    const pool = { totalCount: 15, idleCount: 2, waitingCount: 0, max: 20, options: { max: 20 } };

    for (let i = 0; i < 5; i++) {
      refreshDbPoolMetrics(pool);
    }

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "adaptive_pool_sizing" }),
      expect.any(String),
    );
    expect(pool.options.max).toBe(20);
  });

  test("does not increase when saturated but no waiting clients", () => {
    const pool = { totalCount: 20, idleCount: 0, waitingCount: 0, max: 20, options: { max: 20 } };

    for (let i = 0; i < 5; i++) {
      refreshDbPoolMetrics(pool);
    }

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "adaptive_pool_sizing" }),
      expect.any(String),
    );
    expect(pool.options.max).toBe(20);
  });

  test("resets saturation counter when conditions clear", () => {
    const pool = { totalCount: 20, idleCount: 0, waitingCount: 2, max: 20, options: { max: 20 } };

    // 2 saturated checks
    for (let i = 0; i < 2; i++) {
      refreshDbPoolMetrics(pool);
    }

    // Condition clears
    pool.waitingCount = 0;
    pool.idleCount = 2;
    refreshDbPoolMetrics(pool);

    // Go back to saturated — counter restarts
    pool.waitingCount = 3;
    pool.idleCount = 0;
    for (let i = 0; i < 3; i++) {
      refreshDbPoolMetrics(pool);
    }
    // Only 3 saturated after reset → no resize yet
    expect(pool.options.max).toBe(20);
  });

  test("respects PG_MAX_HARD_CAP ceiling (default 50)", () => {
    const pool = {
      totalCount: 48,
      idleCount: 0,
      waitingCount: 1,
      max: 48,
      options: { max: 48 },
    };

    for (let i = 0; i < 4; i++) {
      refreshDbPoolMetrics(pool);
    }

    // 48 × 1.25 = 60, capped at 50
    expect(pool.options.max).toBe(50);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "adaptive_pool_sizing",
        oldMax: 48,
        newMax: 50,
      }),
      expect.any(String),
    );
  });

  test("does not increase when already at or above hard cap", () => {
    const pool = {
      totalCount: 50,
      idleCount: 0,
      waitingCount: 4,
      max: 50,
      options: { max: 50 },
    };

    for (let i = 0; i < 5; i++) {
      refreshDbPoolMetrics(pool);
    }

    expect(logger.info).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "adaptive_pool_sizing" }),
      expect.any(String),
    );
    expect(pool.options.max).toBe(50);
  });

  test("uses pool.max directly when pool.options is absent", () => {
    const pool = { totalCount: 10, idleCount: 0, waitingCount: 1, max: 10 };

    for (let i = 0; i < 4; i++) {
      refreshDbPoolMetrics(pool);
    }

    // 10 × 1.25 = 12.5 → ceil → 13
    expect(pool.max).toBe(13);
  });
});
