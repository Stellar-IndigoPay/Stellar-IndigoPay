"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

const pool = require("../../db/pool");
const router = require("./retention");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/retention", router);
  return app;
}

describe("Admin Retention Router", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    pool.query.mockResolvedValue({ rows: [{ pending: "2" }], rowCount: 1 });
  });

  test("GET /status returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/retention/status");
    expect(res.status).toBe(401);
  });

  test("GET /status returns configured policies with pendingRows", async () => {
    const res = await request(app)
      .get("/api/admin/retention/status")
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    const device = res.body.data.find((p) => p.name === "device-tokens-delete");
    expect(device.strategy).toBe("delete");
    expect(device.pendingRows).toBe(2);
    expect(device.retentionPeriod).toBeDefined();
  });

  test("POST /run-now with no body runs all policies", async () => {
    const res = await request(app)
      .post("/api/admin/retention/run-now")
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    // at least one delete + the anonymize policy executed
    expect(
      res.body.data.some((r) => r.policy === "device-tokens-delete"),
    ).toBe(true);
  });

  test("POST /run-now with a valid policy name runs only that policy", async () => {
    const res = await request(app)
      .post("/api/admin/retention/run-now")
      .set("X-Admin-Key", "test-admin-key")
      .send({ policy: "device-tokens-delete" });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].policy).toBe("device-tokens-delete");
  });

  test("POST /run-now with an unknown policy returns 400", async () => {
    const res = await request(app)
      .post("/api/admin/retention/run-now")
      .set("X-Admin-Key", "test-admin-key")
      .send({ policy: "not-a-real-policy" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.detail).toMatch(/Unknown retention policy/);
  });

  test("POST /run-now with a non-string policy returns 400", async () => {
    const res = await request(app)
      .post("/api/admin/retention/run-now")
      .set("X-Admin-Key", "test-admin-key")
      .send({ policy: 123 });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("POST /run-now returns 207 when a policy fails", async () => {
    // Force the device-tokens delete to fail.
    pool.query.mockImplementation((sql) => {
      if (sql.startsWith("DELETE FROM device_tokens")) {
        return Promise.reject(new Error("boom"));
      }
      return Promise.resolve({ rows: [{ pending: "0" }], rowCount: 0 });
    });

    const res = await request(app)
      .post("/api/admin/retention/run-now")
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(207);
    expect(res.body.success).toBe(false);
    expect(
      res.body.data.find((r) => r.policy === "device-tokens-delete").status,
    ).toBe("failed");
  });
});
