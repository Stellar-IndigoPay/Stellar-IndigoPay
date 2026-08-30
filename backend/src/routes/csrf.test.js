"use strict";

jest.mock("@sentry/node", () => ({
  init: jest.fn(),
  Handlers: {
    requestHandler: jest.fn(() => (req, res, next) => next()),
    tracingHandler: jest.fn(() => (req, res, next) => next()),
    errorHandler: jest.fn(() => (err, req, res, next) => next(err)),
  },
  captureException: jest.fn(),
  close: jest.fn().mockResolvedValue(),
}));

jest.mock("../routes/ratings", () => {
  const express = require("express");
  const router = express.Router();
  router.post("/", (req, res) => res.status(201).json({ success: true }));
  return router;
});

jest.mock("../services/redis", () => ({
  getClient: jest.fn().mockReturnValue({
    pipeline: () => ({
      zadd: jest.fn(),
      zremrangebyscore: jest.fn(),
      zcard: jest.fn(),
      expire: jest.fn(),
      exec: jest.fn().mockResolvedValue([null, null, [null, 0]]),
    }),
    evalsha: jest.fn().mockResolvedValue([1, 10, 0]),
    script: jest.fn().mockResolvedValue("mock-sha"),
    exists: jest.fn().mockResolvedValue(0),
    set: jest.fn().mockResolvedValue("OK"),
  }),
  initRedis: jest.fn().mockReturnValue({ ring: null }),
}));

jest.mock("pg", () => ({
  Pool: jest.fn(() => ({
    connect: jest.fn().mockResolvedValue({ query: jest.fn(), release: jest.fn() }),
    query: jest.fn().mockResolvedValue({ rows: [] }),
    end: jest.fn().mockResolvedValue(),
    on: jest.fn(),
  }))
}));

const request = require("supertest");
jest.mock("../db/pool", () => ({
  query: jest.fn().mockResolvedValue({ rows: [] }),
  runWithQueryRole: jest.fn((method, cb) => cb())
}));
const app = require("../server");


describe("CSRF protection", () => {
  const agent = request.agent(app);

  it("returns a CSRF token from GET /api/v1/csrf-token", async () => {
    const res = await agent.get("/api/v1/csrf-token").expect(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true }));
    expect(typeof res.body.csrfToken).toBe("string");
    expect(res.body.csrfToken.length).toBeGreaterThan(0);
    expect(res.headers["content-security-policy"]).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
  });

  it("rejects mutating requests without an X-CSRF-Token header", async () => {
    const res = await agent
      .post("/api/v1/ratings")
      .send({
        projectId: "project-1",
        donorAddress:
          "GA123456789012345678901234567890123456789012345678901234",
        rating: 5,
      })
      .expect(403);

    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(res.body.error.message.toLowerCase()).toContain("csrf");
  });

  it("allows mutating requests when a valid X-CSRF-Token header is provided", async () => {
    const tokenResponse = await agent.get("/api/v1/csrf-token").expect(200);
    const token = tokenResponse.body.csrfToken;

    const res = await agent
      .post("/api/v1/ratings")
      .set("X-CSRF-Token", token)
      .send({
        projectId: "project-1",
        donorAddress:
          "GA123456789012345678901234567890123456789012345678901234",
        rating: 5,
      });

    expect(res.status).not.toBe(403);
  });
});
