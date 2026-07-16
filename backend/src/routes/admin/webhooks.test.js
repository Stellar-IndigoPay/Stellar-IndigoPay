"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/webhookQueue", () => ({
  replayDelivery: jest.fn(),
}));

const pool = require("../../db/pool");
const { logAdminAction } = require("../../services/audit");
const { replayDelivery } = require("../../services/webhookQueue");

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/webhooks", require("./webhooks"));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message || "Internal server error" });
  });
  return app;
}

const MOCK_DELIVERY_ROW = {
  id: "delivery-1",
  project_id: "proj-1",
  project_name: "Amazon Reforestation",
  event_id: "evt-abc",
  event_type: "milestone.reached",
  status: "dlq",
  attempts: 6,
  last_attempt_at: new Date("2026-07-10T00:00:00.000Z").toISOString(),
  last_error: "timeout",
  next_attempt_at: null,
  created_at: new Date("2026-07-01T00:00:00.000Z").toISOString(),
  updated_at: new Date("2026-07-10T00:00:00.000Z").toISOString(),
};

describe("Admin Webhooks Router", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  describe("auth", () => {
    test("rejects requests without admin credentials with 401", async () => {
      const res = await request(app).get("/api/admin/webhooks/dead-letter");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /dead-letter", () => {
    test("returns dead-lettered deliveries with pagination", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 1 }] }) // count
        .mockResolvedValueOnce({ rows: [MOCK_DELIVERY_ROW] }); // page

      const res = await request(app)
        .get("/api/admin/webhooks/dead-letter")
        .set("X-Admin-Key", "test-admin-key")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(1);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0]).toMatchObject({
        id: "delivery-1",
        status: "dlq",
        attempts: 6,
        projectName: "Amazon Reforestation",
      });
    });

    test("filters by projectId", async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }] })
        .mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get("/api/admin/webhooks/dead-letter?projectId=proj-1")
        .set("X-Admin-Key", "test-admin-key")
        .expect(200);

      const countQueryParams = pool.query.mock.calls[0][1];
      expect(countQueryParams).toEqual(["proj-1"]);
    });
  });

  describe("POST /dead-letter/:deliveryId/replay", () => {
    test("replays and returns the updated delivery", async () => {
      replayDelivery.mockResolvedValue(true);
      pool.query.mockResolvedValueOnce({
        rows: [{ ...MOCK_DELIVERY_ROW, status: "delivered" }],
      });

      const res = await request(app)
        .post("/api/admin/webhooks/dead-letter/delivery-1/replay")
        .set("X-Admin-Key", "test-admin-key")
        .expect(200);

      expect(replayDelivery).toHaveBeenCalledWith("delivery-1");
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe("delivered");
      expect(logAdminAction).toHaveBeenCalledWith(
        expect.objectContaining({ action: "webhook.dead_letter.replay" }),
      );
    });

    test("returns 404 when the delivery isn't dead-lettered", async () => {
      replayDelivery.mockResolvedValue(false);

      const res = await request(app)
        .post("/api/admin/webhooks/dead-letter/unknown/replay")
        .set("X-Admin-Key", "test-admin-key")
        .expect(404);

      expect(res.body.error).toMatch(/no dead-lettered delivery/i);
    });
  });

  describe("POST /dead-letter/replay-all", () => {
    test("replays all dlq deliveries for a project and returns the count", async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }],
      });
      replayDelivery
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);

      const res = await request(app)
        .post("/api/admin/webhooks/dead-letter/replay-all")
        .set("X-Admin-Key", "test-admin-key")
        .send({ projectId: "proj-1" })
        .expect(200);

      expect(replayDelivery).toHaveBeenCalledTimes(3);
      expect(res.body.success).toBe(true);
      expect(res.body.count).toBe(2);
    });

    test("requires projectId", async () => {
      const res = await request(app)
        .post("/api/admin/webhooks/dead-letter/replay-all")
        .set("X-Admin-Key", "test-admin-key")
        .send({})
        .expect(400);

      expect(res.body.error).toMatch(/projectId/i);
    });
  });

  describe("GET /deliveries", () => {
    test("returns delivery history filtered by projectId and status", async () => {
      pool.query.mockResolvedValueOnce({ rows: [MOCK_DELIVERY_ROW] });

      const res = await request(app)
        .get("/api/admin/webhooks/deliveries?projectId=proj-1&status=dlq")
        .set("X-Admin-Key", "test-admin-key")
        .expect(200);

      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);

      const [query, params] = pool.query.mock.calls[0];
      expect(query).toContain("d.project_id = $1");
      expect(query).toContain("d.status = $2");
      expect(params).toEqual(["proj-1", "dlq", 100]);
    });

    test("ignores an invalid status filter", async () => {
      pool.query.mockResolvedValueOnce({ rows: [] });

      await request(app)
        .get("/api/admin/webhooks/deliveries?status=bogus")
        .set("X-Admin-Key", "test-admin-key")
        .expect(200);

      const query = pool.query.mock.calls[0][0];
      expect(query).not.toContain("d.status =");
    });
  });
});
