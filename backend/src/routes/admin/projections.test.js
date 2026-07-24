"use strict";

/**
 * Tests for the admin projections rebuild endpoint.
 * Mocks the projection engine and audit service; verifies auth + routing.
 */

jest.mock("../../db/pool", () => ({ query: jest.fn() }));
jest.mock("../../services/redis", () => ({ deletePattern: jest.fn() }));
jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const express = require("express");
const request = require("supertest");

// Mock the projection engine module entirely.
jest.mock("../../services/projectionEngine", () => ({
  rebuildAllProjections: jest.fn().mockResolvedValue({ events: 42, durationMs: 123 }),
  rebuildProjection: jest.fn().mockResolvedValue({ events: 7 }),
  isRebuilding: jest.fn().mockReturnValue(false),
  refreshLag: jest.fn().mockResolvedValue(0),
  PROJECTION_NAMES: ["donor_leaderboard", "project_stats", "donor_history", "global_stats"],
}));

const projectionsRoute = require("./projections");
const { rebuildAllProjections, rebuildProjection, isRebuilding, refreshLag } =
  require("../../services/projectionEngine");

process.env.ADMIN_API_KEY = "test-admin-key";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/projections", projectionsRoute);
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}

describe("Admin projections router", () => {
  let app;
  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test("requires admin authentication", async () => {
    await request(app).post("/api/admin/projections/rebuild").expect(401);
  });

  test("POST /rebuild triggers a full rebuild and returns counts", async () => {
    const res = await request(app)
      .post("/api/admin/projections/rebuild")
      .set("X-Admin-Key", "test-admin-key")
      .expect(200);
    expect(rebuildAllProjections).toHaveBeenCalled();
    expect(res.body.success).toBe(true);
    expect(res.body.data.eventsReplayed).toBe(42);
    expect(res.body.data.durationMs).toBe(123);
  });

  test("POST /rebuild returns 409 if a rebuild is already in progress", async () => {
    isRebuilding.mockReturnValue(true);
    const res = await request(app)
      .post("/api/admin/projections/rebuild")
      .set("X-Admin-Key", "test-admin-key")
      .expect(409);
    expect(rebuildAllProjections).not.toHaveBeenCalled();
    expect(res.body.success).toBe(false);
  });

  test("POST /rebuild/:name rebuilds a single projection", async () => {
    const res = await request(app)
      .post("/api/admin/projections/rebuild/donor_leaderboard")
      .set("X-Admin-Key", "test-admin-key")
      .expect(200);
    expect(rebuildProjection).toHaveBeenCalledWith("donor_leaderboard");
    expect(res.body.data.projection).toBe("donor_leaderboard");
  });

  test("POST /rebuild/:name returns 404 for an unknown projection", async () => {
    const res = await request(app)
      .post("/api/admin/projections/rebuild/nope")
      .set("X-Admin-Key", "test-admin-key")
      .expect(404);
    expect(res.body.success).toBe(false);
    expect(rebuildProjection).not.toHaveBeenCalled();
  });

  test("GET /status returns rebuild state and lag", async () => {
    const res = await request(app)
      .get("/api/admin/projections/status")
      .set("X-Admin-Key", "test-admin-key")
      .expect(200);
    expect(refreshLag).toHaveBeenCalled();
    expect(res.body.data).toHaveProperty("rebuilding");
    expect(res.body.data).toHaveProperty("lag");
    expect(Array.isArray(res.body.data.projections)).toBe(true);
  });
});
