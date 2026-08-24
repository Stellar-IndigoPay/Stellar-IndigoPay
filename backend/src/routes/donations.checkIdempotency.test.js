"use strict";

/**
 * src/routes/donations.checkIdempotency.test.js
 *
 * Tests for GET /api/donations/check-idempotency/:key (issue #1096,
 * Workstream 2).  The frontend offline queue calls this before re-submitting
 * a queued donation so it never creates a duplicate record when another tab
 * or a background-sync attempt already recorded the same idempotency key.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("../services/redis", () => ({
  get: jest.fn().mockResolvedValue(null),
  set: jest.fn().mockResolvedValue(undefined),
  deletePattern: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/stellar", () => ({
  getOnChainProject: jest.fn(),
  getProjectDonationEvents: jest.fn(),
  CONTRACT_ID: "test-contract",
  server: { getTransaction: jest.fn().mockResolvedValue({ successful: true }) },
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
}));

jest.mock("../services/oracleService", () => ({
  getCurrentPrice: jest.fn(() => null),
}));

const pool = require("../db/pool");
const express = require("express");
const request = require("supertest");
const donationsRouter = require("./donations");

function buildApp() {
  const app = express();
  app.use(express.json());
  const io = { emit: jest.fn(), to: () => ({ emit: jest.fn() }) };
  app.set("io", io);
  app.use("/api/donations", donationsRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });
  return app;
}

const KEY = "11111111-2222-4333-8444-555555555555";

describe("GET /api/donations/check-idempotency/:key", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns exists:true when the idempotency key was already processed", async () => {
    pool.query.mockResolvedValue({
      rows: [{ response_status: 201 }],
    });

    const res = await request(buildApp()).get(
      `/api/donations/check-idempotency/${KEY}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { exists: true, status: 201 },
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("idempotency_keys"),
      [KEY],
    );
  });

  it("returns exists:false for a key that was never seen", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(buildApp()).get(
      `/api/donations/check-idempotency/${KEY}`,
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { exists: false, status: null },
    });
  });

  it("rejects a non-UUID key with a validation error", async () => {
    const res = await request(buildApp()).get(
      "/api/donations/check-idempotency/not-a-uuid",
    );

    expect(res.status).toBe(400);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
