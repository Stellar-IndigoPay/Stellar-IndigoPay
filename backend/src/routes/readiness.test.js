"use strict";

const express = require("express");
const request = require("supertest");

const readinessRouter = require("./readiness");
const lifecycle = require("../services/lifecycle");

function buildApp() {
  const app = express();
  app.use("/api/readyz", readinessRouter);
  return app;
}

describe("GET /api/readyz (readiness)", () => {
  beforeEach(() => {
    lifecycle._resetForTests();
  });

  test("returns 503 status=draining once shutdown begins (no DB call)", async () => {
    lifecycle.beginShutdown();
    const res = await request(buildApp()).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("draining");
  });

  test("returns 503 not ready when the DB is unreachable (no DATABASE_URL / pool fails)", async () => {
    // The default pool is constructed with localhost:5432 which won't
    // resolve; readiness should still answer quickly with status=not ready.
    const res = await request(buildApp()).get("/api/readyz");
    expect(res.status).toBe(503);
    expect(res.body.status).toBe("not ready");
    expect(res.body.checks.db.status).toBe("unreachable");
  });

  test("response always carries a timestamp + checks map", async () => {
    lifecycle.beginShutdown();
    const res = await request(buildApp()).get("/api/readyz");
    expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.body.checks).toBeDefined();
  });
});
