"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../../db/pool");
const { logAdminAction } = require("../../services/audit");

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/queues", require("./queues"));
  return app;
}

describe("Admin Queues Router", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test("GET /api/admin/queues returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/queues");
    expect(res.status).toBe(401);
  });

  test("GET /api/admin/queues returns 200 with valid X-Admin-Key", async () => {
    const mockStatsResult = { rows: [] };
    const mockPausedResult = { rows: [] };
    pool.query
      .mockResolvedValueOnce(mockStatsResult)
      .mockResolvedValueOnce(mockPausedResult);

    const res = await request(app)
      .get("/api/admin/queues")
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(5);
  });

  test("POST /api/admin/queues/:name/pause pauses queue and logs audit action", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post("/api/admin/queues/webhook-deliveries/pause")
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "queue.pause",
        targetType: "queue",
        targetId: "webhook-deliveries"
      })
    );
  });

  test("POST /api/admin/queues/:name/resume resumes queue and logs audit action", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post("/api/admin/queues/ai-summary/resume")
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "queue.resume",
        targetType: "queue",
        targetId: "ai-summary"
      })
    );
  });

  test("POST /api/admin/queues/:name/purge purges queue and logs audit action", async () => {
    pool.query.mockResolvedValue({ rows: [] });

    const res = await request(app)
      .post("/api/admin/queues/profile-update/purge")
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "queue.purge",
        targetType: "queue",
        targetId: "profile-update"
      })
    );
  });

  test("POST /api/admin/queues/:name/pause returns 400 for invalid queue", async () => {
    const res = await request(app)
      .post("/api/admin/queues/invalid-queue/pause")
      .set("X-Admin-Key", "test-admin-key")
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid queue name/);
  });
});
