"use strict";

jest.mock("../db/pool", () => ({ query: jest.fn() }));

jest.mock("../services/email", () => ({
  sendUpdateNotifications: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/pushQueue", () => ({
  enqueuePushNotification: jest.fn().mockResolvedValue(undefined),
}));

process.env.ADMIN_API_KEY = "test-admin-key";

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const { enqueuePushNotification } = require("../services/pushQueue");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/updates", require("./updates"));
  app.use((err, _req, res, _next) => {
    res
      .status(err.status || 500)
      .json({ error: err.message || "Internal server error" });
  });
  return app;
}

describe("POST /api/updates — push notification enqueue", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("enqueues a project_update push job after creating the update", async () => {
    const project = { id: "project-1", name: "Mangrove Restoration" };
    const updateRow = {
      id: "update-1",
      project_id: "project-1",
      title: "We planted 500 trees!",
      body: "Big milestone for the grove.",
      created_at: "2026-07-01T00:00:00.000Z",
    };

    pool.query
      .mockResolvedValueOnce({ rows: [project] }) // SELECT project
      .mockResolvedValueOnce({ rows: [updateRow] }) // INSERT update
      .mockResolvedValueOnce({ rows: [] }); // SELECT project_subscriptions (email)

    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({
        projectId: "project-1",
        title: updateRow.title,
        body: updateRow.body,
      });

    expect(res.status).toBe(201);
    expect(enqueuePushNotification).toHaveBeenCalledWith({
      type: "project_update",
      payload: {
        project: expect.objectContaining({ id: "project-1" }),
        update: expect.objectContaining({ id: "update-1" }),
      },
    });
  });

  test("a failed push enqueue is logged and does not fail the request", async () => {
    const project = { id: "project-1", name: "Mangrove Restoration" };
    const updateRow = {
      id: "update-2",
      project_id: "project-1",
      title: "Another update",
      body: "More progress.",
      created_at: "2026-07-02T00:00:00.000Z",
    };

    pool.query
      .mockResolvedValueOnce({ rows: [project] })
      .mockResolvedValueOnce({ rows: [updateRow] })
      .mockResolvedValueOnce({ rows: [] });

    enqueuePushNotification.mockRejectedValueOnce(new Error("queue down"));

    const res = await request(app)
      .post("/api/updates")
      .set("X-Admin-Key", "test-admin-key")
      .send({
        projectId: "project-1",
        title: updateRow.title,
        body: updateRow.body,
      });

    expect(res.status).toBe(201);
  });

  test("rejects unauthenticated requests before touching the push queue", async () => {
    const res = await request(app).post("/api/updates").send({
      projectId: "project-1",
      title: "x",
      body: "y",
    });

    expect(res.status).toBe(401);
    expect(enqueuePushNotification).not.toHaveBeenCalled();
  });
});
