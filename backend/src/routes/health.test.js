"use strict";

const express = require("express");
const request = require("supertest");

const healthRouter = require("./health");
const lifecycle = require("../services/lifecycle");

function buildApp() {
  const app = express();
  app.use("/api/health", healthRouter);
  return app;
}

describe("GET /api/health (liveness)", () => {
  beforeEach(() => {
    lifecycle._resetForTests();
  });

  test("returns 200 with status=ok after the boot grace window", async () => {
    // process.uptime() is 0 right after require, which is < 5s, so we
    // bypass the boot-grace check by waiting via a setTimeout.
    // Easier: monkey-patch process.uptime for this test.
    const real = process.uptime;
    process.uptime = () => 30;
    try {
      const res = await request(buildApp()).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.service).toBe("stellar-indigopay-api");
    } finally {
      process.uptime = real;
    }
  });

  test("returns 503 status=starting during the 5s boot grace window", async () => {
    const real = process.uptime;
    process.uptime = () => 1;
    try {
      const res = await request(buildApp()).get("/api/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("starting");
    } finally {
      process.uptime = real;
    }
  });

  test("returns 503 status=draining as soon as graceful shutdown begins", async () => {
    const real = process.uptime;
    process.uptime = () => 30;
    lifecycle.beginShutdown();
    try {
      const res = await request(buildApp()).get("/api/health");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("draining");
    } finally {
      process.uptime = real;
    }
  });

  test("response carries a timestamp in ISO-8601 format", async () => {
    const real = process.uptime;
    process.uptime = () => 30;
    try {
      const res = await request(buildApp()).get("/api/health");
      expect(res.body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    } finally {
      process.uptime = real;
    }
  });
});
