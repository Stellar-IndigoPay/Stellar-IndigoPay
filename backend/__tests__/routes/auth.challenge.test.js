"use strict";

/**
 * __tests__/routes/auth.challenge.test.js
 *
 * GET /api/auth/challenge — issues a server-side, expiring, single-use nonce
 * for the donor challenge/response flow (issue #1102, Part A).
 */

const request = require("supertest");
const express = require("express");

jest.mock("../../src/middleware/rateLimiter", () => ({
  createRateLimiter: jest.fn(() => (req, res, next) => next()),
}));

jest.mock("../../src/services/redis", () => ({
  storeDonorNonce: jest.fn(async () => true),
  claimDonorNonce: jest.fn(async () => "ok"),
  donorNonceIssued: jest.fn(async () => true),
}));

const redis = require("../../src/services/redis");
const authRouter = require("../../src/routes/auth");
const { AppError } = require("../../src/errors");

function buildApp() {
  const app = express();
  app.use("/api/auth", authRouter);
  // Central error handler matching the production shape.
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: { code: "INTERNAL_ERROR", message: err.message } });
  });
  return app;
}

describe("GET /api/auth/challenge", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("returns a 64-hex nonce and an ISO-8601 expiresAt in the future", async () => {
    const res = await request(buildApp()).get("/api/auth/challenge");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(res.body.data.expiresAt))).toBe(false);
    expect(Date.parse(res.body.data.expiresAt)).toBeGreaterThan(Date.now());
  });

  test("persists the issued nonce marker with the challenge TTL", async () => {
    const res = await request(buildApp()).get("/api/auth/challenge");

    expect(redis.storeDonorNonce).toHaveBeenCalledTimes(1);
    expect(redis.storeDonorNonce.mock.calls[0][0]).toBe(res.body.data.nonce);
    expect(redis.storeDonorNonce.mock.calls[0][1]).toBeGreaterThan(0);
  });

  test("issues a fresh nonce on every call", async () => {
    const first = await request(buildApp()).get("/api/auth/challenge");
    const second = await request(buildApp()).get("/api/auth/challenge");

    expect(first.body.data.nonce).not.toBe(second.body.data.nonce);
    expect(redis.storeDonorNonce).toHaveBeenCalledTimes(2);
  });

  test("returns 503 when the nonce cannot be persisted", async () => {
    redis.storeDonorNonce.mockResolvedValueOnce(false);

    const res = await request(buildApp()).get("/api/auth/challenge");

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("SERVICE_UNAVAILABLE");
  });
});
