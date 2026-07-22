/**
 * src/routes/admin/metrics.test.js
 *
 * Tests for the admin SLO metrics proxy endpoint.
 * Verifies authentication gating and response shapes.
 */
"use strict";

const request = require("supertest");
const express = require("express");
const metricsRouter = require("./metrics");

// The adminRequired middleware is imported from ../../middleware/auth.
// We mock it to avoid needing a real auth setup in unit tests.
jest.mock("../../middleware/auth", () => ({
  adminRequired: jest.fn((req, res, next) => {
    // Simulate an authenticated admin by default
    req.admin = { sub: "test_admin", role: "admin" };
    next();
  }),
}));

const { adminRequired } = require("../../middleware/auth");

// Mock global fetch
global.fetch = jest.fn();

// Save original env
const ORIGINAL_PROMETHEUS_URL = process.env.PROMETHEUS_URL;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/metrics", metricsRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PROMETHEUS_URL;
});

afterAll(() => {
  if (ORIGINAL_PROMETHEUS_URL) {
    process.env.PROMETHEUS_URL = ORIGINAL_PROMETHEUS_URL;
  } else {
    delete process.env.PROMETHEUS_URL;
  }
});

describe("GET /api/admin/metrics/slo", () => {
  it("requires admin authentication", async () => {
    adminRequired.mockImplementationOnce((req, res, next) => {
      return res.status(401).json({ error: { code: "UNAUTHORIZED", message: "Authentication required" } });
    });

    const app = createApp();
    const res = await request(app).get("/api/admin/metrics/slo");
    expect(res.status).toBe(401);
  });

  it("returns SLO data when Prometheus responds successfully", async () => {
    global.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "success",
        data: {
          result: [
            {
              metric: {},
              value: [1234567890, "0.002"],
            },
          ],
        },
      }),
    });

    const app = createApp();
    const res = await request(app).get("/api/admin/metrics/slo");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty("donations");
    expect(res.body.data).toHaveProperty("projects");
    expect(res.body.data.donations).toHaveProperty("errorRatio");
    expect(res.body.data.donations).toHaveProperty("errorBudgetRemaining");
    expect(typeof res.body.data.donations.errorRatio).toBe("number");
  });

  it("returns zeroed data when Prometheus is unreachable", async () => {
    global.fetch.mockRejectedValue(new Error("Prometheus unreachable"));

    const app = createApp();
    const res = await request(app).get("/api/admin/metrics/slo");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.donations.errorRatio).toBe(0);
    expect(res.body.data.donations.errorBudgetRemaining).toBe(100);
    expect(res.body.data.donations).toHaveProperty("error");
  });

  it("handles partial Prometheus failures gracefully", async () => {
    // Donations query succeeds, projects query fails
    let callCount = 0;
    global.fetch.mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            status: "success",
            data: {
              result: [
                {
                  metric: {},
                  value: [1234567890, "0.001"],
                },
              ],
            },
          }),
        });
      }
      return Promise.reject(new Error("Projects query failed"));
    });

    const app = createApp();
    const res = await request(app).get("/api/admin/metrics/slo");

    expect(res.status).toBe(200);
    expect(res.body.data.donations.errorRatio).toBe(0.001);
    expect(res.body.data.donations.errorBudgetRemaining).toBe(80);
    // Projects should have zeroed data with error message
    expect(res.body.data.projects.errorRatio).toBe(0);
    expect(res.body.data.projects).toHaveProperty("error");
  });
});
