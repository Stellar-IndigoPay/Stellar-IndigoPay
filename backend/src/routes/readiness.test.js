"use strict";

const express = require("express");
const request = require("supertest");

const readinessRouter = require("./readiness");
const lifecycle = require("../services/lifecycle");
const pool = require("../db/pool");
const originalRedisUrl = process.env.REDIS_URL;

function buildApp() {
  const app = express();
  app.use("/api/readyz", readinessRouter);
  return app;
}

describe("GET /api/readyz (readiness)", () => {
  beforeEach(() => {
    lifecycle._resetForTests();
    delete process.env.REDIS_URL;
    global.fetch = jest.fn().mockResolvedValue({ ok: true });
    jest.spyOn(pool, "checkReplicaLag").mockResolvedValue({
      hasReplica: false,
      lagMs: 0,
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (originalRedisUrl) {
      process.env.REDIS_URL = originalRedisUrl;
    } else {
      delete process.env.REDIS_URL;
    }
  });

  test("returns 503 status=draining once shutdown begins (no DB call)", async () => {
    lifecycle.beginShutdown();
    const res = await request(buildApp()).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("draining");
  });

  test("returns 503 not ready when the DB is unreachable (no DATABASE_URL / pool fails)", async () => {
    // Simulate an unreachable database so the test is independent of the
    // surrounding environment (local unit tests vs. docker-compose CI).
    jest
      .spyOn(pool.getWriter(), "query")
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

    const res = await request(buildApp()).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not ready");
    expect(res.body.checks.db.status).toBe("unreachable");
  });

  test("returns 503 when configured replica lag is exceeded", async () => {
    jest.spyOn(pool.getWriter(), "query").mockResolvedValueOnce({ rows: [] });
    pool.checkReplicaLag.mockResolvedValueOnce({
      hasReplica: true,
      lagMs: 6000,
    });

    const res = await request(buildApp()).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.checks.readReplicaLag.status).toBe("degraded");
    expect(res.body.checks.readReplicaLag.maxLagMs).toBe(5000);
  });

  test("response always carries a timestamp + checks map", async () => {
    lifecycle.beginShutdown();
    const res = await request(buildApp()).get("/api/readyz");
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.checks).toBeDefined();
  });
});
