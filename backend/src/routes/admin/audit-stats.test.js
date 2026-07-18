"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

// Mock the pg pool so the stats queries run without a live database.
const mockPoolQuery = jest.fn();
jest.mock("../../db/pool", () => ({
  query: (...args) => mockPoolQuery(...args),
}));

// Mock redis so the cache layer is exercised but never touches a real server.
const mockRedisGet = jest.fn().mockResolvedValue(null);
const mockRedisSet = jest.fn().mockResolvedValue("OK");
jest.mock("../../services/redis", () => ({
  get: (...args) => mockRedisGet(...args),
  set: (...args) => mockRedisSet(...args),
  deletePattern: jest.fn(),
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

describe("GET /api/admin/audit-log/stats", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    mockPoolQuery.mockReset();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue("OK");
  });

  it("returns 401 without an admin token", async () => {
    const res = await request(app).get("/api/admin/audit-log/stats");
    expect(res.status).toBe(401);
  });

  it("returns aggregated stats for an admin", async () => {
    const fakeDate = new Date("2026-07-16T00:00:00Z");
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [{ action: "login", count: "5" }] })
      .mockResolvedValueOnce({ rows: [{ actor: "admin", count: "5" }] })
      .mockResolvedValueOnce({ rows: [{ date: "2026-07-16", count: "5" }] })
      .mockResolvedValueOnce({
        rows: [
          {
            total_entries: "5",
            oldest_entry: fakeDate,
            newest_entry: fakeDate,
          },
        ],
      });

    const res = await request(app)
      .get("/api/admin/audit-log/stats")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(Array.isArray(data.topActions)).toBe(true);
    expect(data.topActions[0]).toEqual({ action: "login", count: 5 });
    expect(Array.isArray(data.topActors)).toBe(true);
    expect(data.topActors[0]).toEqual({ actor: "admin", count: 5 });
    expect(Array.isArray(data.dailyVolume)).toBe(true);
    expect(data.dailyVolume[0]).toEqual({ date: "2026-07-16", count: 5 });
    expect(data.totalEntries).toBe(5);
    expect(data.oldestEntry).toBeDefined();
    expect(data.newestEntry).toBeDefined();

    // Cache should have been populated (redis.set called).
    expect(mockRedisSet).toHaveBeenCalled();
  });

  it("returns zeroed stats when the log is empty", async () => {
    mockPoolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          { total_entries: "0", oldest_entry: null, newest_entry: null },
        ],
      });

    const res = await request(app)
      .get("/api/admin/audit-log/stats")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.totalEntries).toBe(0);
    expect(res.body.data.topActions).toEqual([]);
  });
});
