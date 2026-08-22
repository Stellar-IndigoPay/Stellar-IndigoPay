"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn(), connect: jest.fn() }));
jest.mock("../middleware/idempotency", () => (req, res, next) => next());
jest.mock("../middleware/cache", () => ({ invalidateCache: jest.fn() }));
jest.mock("../services/profileQueue", () => ({ enqueueProfileUpdate: jest.fn().mockResolvedValue() }));
jest.mock("../services/impactQueue", () => ({ enqueueImpactRecalc: jest.fn().mockResolvedValue() }));
jest.mock("../services/pushQueue", () => ({ enqueuePushNotification: jest.fn().mockResolvedValue() }));
jest.mock("../services/stellar", () => ({ server: { getTransaction: jest.fn() } }));
jest.mock("../services/oracleService", () => ({ getCurrentPrice: jest.fn(() => 0.1) }));
jest.mock("../services/cacheManager", () => ({ invalidateProjectRelatedCache: jest.fn().mockResolvedValue() }));
jest.mock("../services/receiptGenerator", () => ({
  generateReceiptPdf: jest.fn(),
  hashReceiptContent: jest.fn(),
  signReceipt: jest.fn(),
  getOrGenerateReceiptPdf: jest.fn(),
}));
jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
  slidingWindowRateLimit: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const { getOrGenerateReceiptPdf } = require("../services/receiptGenerator");
const { slidingWindowRateLimit } = require("../middleware/rateLimiter");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/donations", require("./donations"));
  // Fallback error handler for AppError paths — this test file doesn't
  // assert exact status codes coming through here (see note below), it
  // just needs SOME response so requests don't hang / throw.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    res.status(status).json({ error: { code: err.code || "INTERNAL", message: err.message } });
  });
  return app;
}

const DONATION_ID = "11111111-1111-4111-8111-111111111111";

function donationRow(overrides = {}) {
  return {
    id: DONATION_ID,
    donor_address: "GDONOR1",
    transaction_hash: "a".repeat(64),
    anonymous: false,
    project_name: "Reforest Now",
    wallet_address: "GPROJECT1",
    co2_offset_kg: 1,
    amount_xlm: 10,
    amount: 10,
    currency: "XLM",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/donations/:id/receipt", () => {
  it("returns the generated PDF with correct headers when under the rate limit", async () => {
    pool.query.mockResolvedValueOnce({ rows: [donationRow()] });
    slidingWindowRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 4, reset: 3600 });
    getOrGenerateReceiptPdf.mockResolvedValueOnce({
      pdf: Buffer.from("%PDF-1.4 fake"),
      source: "generated",
    });

    const app = buildApp();
    const res = await request(app).get(`/api/donations/${DONATION_ID}/receipt`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/pdf/);
    expect(res.headers["content-disposition"]).toContain(
      `indigopay-receipt-${DONATION_ID}.pdf`,
    );
  });

  it("checks the per-donor rate limit before generating, keyed on donor address", async () => {
    pool.query.mockResolvedValueOnce({ rows: [donationRow({ donor_address: "GDONOR42" })] });
    slidingWindowRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 4, reset: 3600 });
    getOrGenerateReceiptPdf.mockResolvedValueOnce({
      pdf: Buffer.from("%PDF-1.4 fake"),
      source: "generated",
    });

    const app = buildApp();
    await request(app).get(`/api/donations/${DONATION_ID}/receipt`);

    expect(slidingWindowRateLimit).toHaveBeenCalledWith(
      "ratelimit:sw:receipt:GDONOR42",
      expect.any(Number),
      expect.any(Number),
    );
  });

  it("passes the donation id and transaction hash to getOrGenerateReceiptPdf", async () => {
    pool.query.mockResolvedValueOnce({ rows: [donationRow({ transaction_hash: "b".repeat(64) })] });
    slidingWindowRateLimit.mockResolvedValueOnce({ allowed: true, remaining: 4, reset: 3600 });
    getOrGenerateReceiptPdf.mockResolvedValueOnce({
      pdf: Buffer.from("%PDF-1.4 fake"),
      source: "redis",
    });

    const app = buildApp();
    await request(app).get(`/api/donations/${DONATION_ID}/receipt`);

    expect(getOrGenerateReceiptPdf).toHaveBeenCalledWith(
      DONATION_ID,
      "b".repeat(64),
      expect.any(Function),
    );
  });

  it("returns 429 with a Retry-After header and never calls getOrGenerateReceiptPdf when the per-donor limit is exceeded", async () => {
    pool.query.mockResolvedValueOnce({ rows: [donationRow()] });
    slidingWindowRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, reset: 120 });

    const app = buildApp();
    const res = await request(app).get(`/api/donations/${DONATION_ID}/receipt`);

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("120");
    expect(getOrGenerateReceiptPdf).not.toHaveBeenCalled();
  });

  it("does not check the rate limit or generate for an anonymous donation", async () => {
    pool.query.mockResolvedValueOnce({ rows: [donationRow({ anonymous: true })] });

    const app = buildApp();
    const res = await request(app).get(`/api/donations/${DONATION_ID}/receipt`);

    expect(res.status).not.toBe(200);
    expect(slidingWindowRateLimit).not.toHaveBeenCalled();
    expect(getOrGenerateReceiptPdf).not.toHaveBeenCalled();
  });

  it("does not check the rate limit or generate when the donation does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const app = buildApp();
    const res = await request(app).get(`/api/donations/${DONATION_ID}/receipt`);

    expect(res.status).not.toBe(200);
    expect(slidingWindowRateLimit).not.toHaveBeenCalled();
    expect(getOrGenerateReceiptPdf).not.toHaveBeenCalled();
  });
});