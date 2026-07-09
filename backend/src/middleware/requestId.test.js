"use strict";

const express = require("express");
const request = require("supertest");
const requestId = require("./requestId");

function buildApp(reqIdSeed) {
  const app = express();
  // Seed req.id the way pino-http does (so the middleware can pick it up).
  app.use((req, res, next) => {
    req.id = reqIdSeed || req.headers["x-request-id"] || "test-correlation-id";
    next();
  });
  app.use(requestId);
  app.get("/", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("requestId middleware", () => {
  test("sets the X-Request-Id response header from req.id", async () => {
    const app = buildApp("abc-123");
    const res = await request(app).get("/");
    expect(res.headers["x-request-id"]).toBe("abc-123");
  });

  test("uses X-Request-Id from the inbound request if req.id is absent", async () => {
    const app = buildApp(null);
    const res = await request(app).get("/").set("X-Request-Id", "from-client");
    // When req.id is null, the middleware falls back to the inbound header.
    expect(res.headers["x-request-id"]).toBe("from-client");
  });

  test("does not overwrite an existing X-Request-Id header", async () => {
    const app = express();
    app.use((req, res, next) => { req.id = "x"; next(); });
    app.use((_req, res, next) => { res.setHeader("X-Request-Id", "pinned"); next(); });
    app.use(requestId);
    app.get("/", (_req, res) => res.json({ ok: true }));
    const res = await request(app).get("/");
    expect(res.headers["x-request-id"]).toBe("pinned");
  });
});
