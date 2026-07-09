"use strict";

const { registry, metrics, normaliseRoute, refreshDbPoolMetrics } = require("./metrics");

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
    metrics.httpRequestsTotal.inc({ method: "GET", route: "/api/projects", status_code: "200" }, 3);
    const text = await registry.metrics();
    expect(text).toMatch(/http_requests_total\{[^}]*route="\/api\/projects"[^}]*status_code="200"[^}]*\} 3/);
  });

  test("http_request_duration_seconds histogram observes a value", async () => {
    metrics.httpRequestDurationSeconds.observe({ method: "GET", route: "/api/health", status_code: "200" }, 0.123);
    const text = await registry.metrics();
    // The histogram exposes _count, _sum, and _bucket{le=...} series.
    expect(text).toMatch(/http_request_duration_seconds_count\{[^}]*route="\/api\/health"[^}]*\}/);
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
    const fakePool = { totalCount: 12, idleCount: 8, waitingCount: 2 };
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

  test("registry.contentType is the Prometheus text format", () => {
    expect(registry.contentType).toMatch(/text\/plain/);
  });
});
