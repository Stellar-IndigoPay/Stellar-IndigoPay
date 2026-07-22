"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));
jest.mock("../../services/redis", () => ({ deletePattern: jest.fn() }));
jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../../db/pool");
const redis = require("../../services/redis");
const { logAdminAction } = require("../../services/audit");

process.env.ADMIN_API_KEY = "test-admin-key";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/projects", require("./projects"));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

const PROJECT = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Forest restoration",
  description: "Restoring a native forest ecosystem.",
  category: "Reforestation",
  location: "Brazil",
  wallet_address: "GABC",
  goal_xlm: "100",
  raised_xlm: "10",
  donor_count: 2,
  co2_offset_kg: 25,
  status: "active",
  verified: true,
  on_chain_verified: false,
  tags: [],
  created_at: "2026-07-01T00:00:00.000Z",
  updated_at: "2026-07-01T00:00:00.000Z",
  deactivated_at: null,
  deactivated_by: null,
};

describe("Admin projects router", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test("requires admin authentication", async () => {
    await request(app).get("/api/admin/projects").expect(401);
  });

  test("lists projects with search and excludes deactivated rows by default", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [{ total: 1 }] })
      .mockResolvedValueOnce({ rows: [PROJECT] });

    const response = await request(app)
      .get("/api/admin/projects?search=forest")
      .set("X-Admin-Key", "test-admin-key")
      .expect(200);

    expect(response.body.total).toBe(1);
    expect(response.body.data[0]).toMatchObject({ id: PROJECT.id, name: PROJECT.name });
    expect(pool.query.mock.calls[0][0]).toContain("deactivated_at IS NULL");
    expect(pool.query.mock.calls[0][1]).toEqual(["%forest%"]);
  });

  test("updates a project and records an audit event", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...PROJECT, status: "paused" }] });

    const response = await request(app)
      .patch(`/api/admin/projects/${PROJECT.id}`)
      .set("X-Admin-Key", "test-admin-key")
      .send({ status: "paused", co2OffsetKg: 30 })
      .expect(200);

    expect(response.body.data.status).toBe("paused");
    expect(redis.deletePattern).toHaveBeenCalledWith("projects:list:*");
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({
      action: "project.update", targetId: PROJECT.id,
    }));
  });

  test("soft-deletes instead of deleting the project row", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ ...PROJECT, status: "inactive", deactivated_by: "admin-key" }] });

    await request(app)
      .delete(`/api/admin/projects/${PROJECT.id}`)
      .set("X-Admin-Key", "test-admin-key")
      .expect(200);

    expect(pool.query.mock.calls[0][0]).toContain("UPDATE projects SET status = 'inactive'");
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: "project.deactivate" }));
  });

  test("wraps batch status and CO2 changes in a transaction", async () => {
    const client = {
      query: jest.fn()
        .mockResolvedValueOnce({}) // BEGIN
        .mockResolvedValueOnce({ rows: [{ ...PROJECT, status: "inactive", co2_offset_kg: 40 }] })
        .mockResolvedValueOnce({}), // COMMIT
      release: jest.fn(),
    };
    pool.connect.mockResolvedValueOnce(client);

    const response = await request(app)
      .post("/api/admin/projects/batch")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectIds: [PROJECT.id], status: "inactive", co2OffsetKg: 40 })
      .expect(200);

    expect(response.body.count).toBe(1);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    expect(logAdminAction).toHaveBeenCalledWith(expect.objectContaining({ action: "project.batch_update" }));
    expect(client.release).toHaveBeenCalled();
  });

  test("rejects invalid batch input before opening a transaction", async () => {
    await request(app)
      .post("/api/admin/projects/batch")
      .set("X-Admin-Key", "test-admin-key")
      .send({ projectIds: [PROJECT.id], status: "invalid" })
      .expect(400);
    expect(pool.connect).not.toHaveBeenCalled();
  });
});
