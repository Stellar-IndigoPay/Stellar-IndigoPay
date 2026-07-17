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
