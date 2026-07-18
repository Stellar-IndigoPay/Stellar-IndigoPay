"use strict";

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../../db/pool");
const { signToken } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const co2Router = require("./co2");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/co2", co2Router);
  app.use((err, _req, res, _next) => {
    res
      .status(err.status || 500)
      .json({ error: err.message || "Internal server error" });
  });
  return app;
}

function adminToken() {
  return signToken({ role: "admin", sub: "admin" }, "1h");
}

const FLAGGED_PROJECT_ROW = {
  id: "22222222-2222-2222-2222-222222222222",
  name: "Acme Solar Farm Phase 1",
  category: "Solar Energy",
  location: "Nairobi, Kenya",
  wallet_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  verified: false,
  co2_verification_status: "flagged",
  co2_verification_notes: "Rate 45 kg/XLM is 15.0× the Solar Energy benchmark",
  co2_offset_kg: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

describe("GET /api/admin/co2/flags", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("requires admin auth", async () => {
    const res = await request(app).get("/api/admin/co2/flags");
    expect(res.status).toBe(401);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("lists flagged + review projects by default", async () => {
    pool.query.mockResolvedValueOnce({ rows: [FLAGGED_PROJECT_ROW] });

    const res = await request(app)
      .get("/api/admin/co2/flags")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({
      id: FLAGGED_PROJECT_ROW.id,
      co2VerificationStatus: "flagged",
      category: "Solar Energy",
    });
    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/co2_verification_status IN \('flagged', 'review'\)/);
  });

  test("filters by a single status when provided", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get("/api/admin/co2/flags?status=review")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/co2_verification_status = \$1/);
    expect(values[0]).toBe("review");
  });

  test("rejects an unknown status filter", async () => {
    const res = await request(app)
      .get("/api/admin/co2/flags?status=bogus")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/status must be one of/);
    expect(pool.query).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/co2/benchmarks", () => {
  test("returns the benchmark table and thresholds", async () => {
    const app = buildApp();
    const res = await request(app)
      .get("/api/admin/co2/benchmarks")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.benchmarks["Solar Energy"]).toEqual({
      co2_per_xlm_typical: 3.0,
      max_reasonable: 30,
    });
    expect(res.body.data.thresholds).toEqual({
      reviewMultiplier: 3,
      flagMultiplier: 10,
    });
  });
});

describe("PATCH /api/admin/co2/flags/:projectId/resolve", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("resolves a flag as verified and audit-logs the decision", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [FLAGGED_PROJECT_ROW] }) // SELECT
      .mockResolvedValueOnce({
        rows: [
          {
            ...FLAGGED_PROJECT_ROW,
            co2_verification_status: "verified",
            co2_verification_notes: "Methodology docs check out",
          },
        ],
      }); // UPDATE

    const res = await request(app)
      .patch(`/api/admin/co2/flags/${FLAGGED_PROJECT_ROW.id}/resolve`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ resolution: "verified", notes: "Methodology docs check out" });

    expect(res.status).toBe(200);
    expect(res.body.data.co2VerificationStatus).toBe("verified");
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "co2.resolve.verified",
        targetType: "project",
        targetId: FLAGGED_PROJECT_ROW.id,
      }),
    );
  });

  test("resolves a flag as rejected", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [FLAGGED_PROJECT_ROW] })
      .mockResolvedValueOnce({
        rows: [
          { ...FLAGGED_PROJECT_ROW, co2_verification_status: "rejected" },
        ],
      });

    const res = await request(app)
      .patch(`/api/admin/co2/flags/${FLAGGED_PROJECT_ROW.id}/resolve`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ resolution: "rejected" });

    expect(res.status).toBe(200);
    expect(res.body.data.co2VerificationStatus).toBe("rejected");
  });

  test("rejects an invalid resolution value", async () => {
    const res = await request(app)
      .patch(`/api/admin/co2/flags/${FLAGGED_PROJECT_ROW.id}/resolve`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ resolution: "maybe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/resolution must be one of/);
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("returns 404 for a missing project", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch("/api/admin/co2/flags/does-not-exist/resolve")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ resolution: "verified" });

    expect(res.status).toBe(404);
  });
});
