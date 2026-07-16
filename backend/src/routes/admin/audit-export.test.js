"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

// Mock the DB pool so tests run without a live Postgres. We capture the last
// query + values so we can assert export filters are applied correctly.
const captured = { query: null, values: null };
const mockRows = [
  {
    id: "e1",
    actor: "admin",
    action: "login",
    target_type: null,
    target_id: null,
    metadata: "{\"k\":\"v\"}",
    ip_address: "127.0.0.1",
    created_at: "2026-07-16T00:00:00.000Z",
  },
];
jest.mock("../../db/pool", () => ({
  query: jest.fn((text, values) => {
    captured.query = text;
    captured.values = values || [];
    return Promise.resolve({ rows: mockRows });
  }),
}));

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

const { signToken } = require("../../middleware/auth");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin", require("../admin"));
  return app;
}

function adminToken() {
  return signToken({ role: "admin", sub: "admin" }, "1h");
}

describe("GET /api/admin/audit-log/export/csv", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    captured.query = null;
    captured.values = null;
    require("../admin/audit-export").__resetExportBuckets();
  });

  it("returns 401 without an admin token", async () => {
    const res = await request(app).get("/api/admin/audit-log/export/csv");
    expect(res.status).toBe(401);
  });

  it("returns CSV with the correct columns for an admin", async () => {
    const res = await request(app)
      .get("/api/admin/audit-log/export/csv")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/csv/);
    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe(
      "id,actor,action,target_type,target_id,metadata,ip_address,created_at",
    );
    expect(lines.length).toBe(2); // header + 1 row
  });

  it("applies actor + action filters to the query", async () => {
    await request(app)
      .get("/api/admin/audit-log/export/csv?actor=admin&action=login")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(captured.query).toContain("WHERE");
    expect(captured.query).toContain("actor = $1");
    expect(captured.query).toContain("action = $2");
    expect(captured.values).toEqual(["admin", "login"]);
  });

  it("applies metadataKey/metadataValue JSONB filter", async () => {
    await request(app)
      .get(
        "/api/admin/audit-log/export/csv?metadataKey=k&metadataValue=v",
      )
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(captured.query).toContain("metadata ->> $");
    expect(captured.values).toContain("k");
    expect(captured.values).toContain("v");
  });
});

describe("GET /api/admin/audit-log/export/json", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    require("../admin/audit-export").__resetExportBuckets();
  });

  it("returns 401 without an admin token", async () => {
    const res = await request(app).get("/api/admin/audit-log/export/json");
    expect(res.status).toBe(401);
  });

  it("returns JSON array of rows for an admin", async () => {
    const res = await request(app)
      .get("/api/admin/audit-log/export/json")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBe(1);
    expect(res.body.data[0].id).toBe("e1");
  });

  it("rate-limits a second export within the window", async () => {
    const token = adminToken();
    const first = await request(app)
      .get("/api/admin/audit-log/export/json")
      .set("Authorization", `Bearer ${token}`);
    expect(first.status).toBe(200);

    const second = await request(app)
      .get("/api/admin/audit-log/export/json")
      .set("Authorization", `Bearer ${token}`);
    expect(second.status).toBe(429);
    expect(second.body.retryAfter).toBeGreaterThan(0);
  });
});
