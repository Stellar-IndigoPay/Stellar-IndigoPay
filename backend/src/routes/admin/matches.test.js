/**
 * src/routes/admin/matches.test.js
 */
"use strict";

jest.mock("../../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../../db/pool");
const { signToken } = require("../../middleware/auth");
const matchesAdminRouter = require("./matches");

const VALID_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const VALID_MATCHER_ADDRESS = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const VALID_MATCH_ID = "22222222-2222-2222-2222-222222222222";
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const DB_MATCH_ROW = {
  id: VALID_MATCH_ID,
  project_id: VALID_PROJECT_ID,
  matcher_address: VALID_MATCHER_ADDRESS,
  cap_xlm: "10000.0000000",
  multiplier: 2,
  matched_xlm: "500.0000000",
  expires_at: FUTURE_DATE,
  status: "active",
  created_at: new Date().toISOString(),
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/matches", matchesAdminRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: { code: err.code || "INTERNAL_ERROR", message: err.message } });
  });
  return app;
}

function adminToken() {
  return signToken({ role: "admin", sub: "admin" }, "1h");
}

// ── POST /api/admin/matches ──────────────────────────────────────────────────
describe("POST /api/admin/matches", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 401 without auth token", async () => {
    const res = await request(app).post("/api/admin/matches").send({});
    expect(res.status).toBe(401);
  });

  test("creates a match pool and returns 201", async () => {
    // First query: project check; second: INSERT
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: VALID_PROJECT_ID }] })
      .mockResolvedValueOnce({ rows: [DB_MATCH_ROW] });

    const res = await request(app)
      .post("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        projectId: VALID_PROJECT_ID,
        matcherAddress: VALID_MATCHER_ADDRESS,
        capXLM: 10000,
        multiplier: 2,
        expiresAt: FUTURE_DATE,
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe(VALID_MATCH_ID);
    expect(res.body.data.multiplier).toBe(2);
    expect(res.body.data.status).toBe("active");
  });

  test("rejects missing projectId with 400", async () => {
    const res = await request(app)
      .post("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ matcherAddress: VALID_MATCHER_ADDRESS, capXLM: 100, expiresAt: FUTURE_DATE });

    expect(res.status).toBe(400);
  });

  test("rejects invalid matcherAddress with 400", async () => {
    const res = await request(app)
      .post("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        projectId: VALID_PROJECT_ID,
        matcherAddress: "not-a-stellar-address",
        capXLM: 100,
        expiresAt: FUTURE_DATE,
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  test("rejects non-positive capXLM", async () => {
    const res = await request(app)
      .post("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        projectId: VALID_PROJECT_ID,
        matcherAddress: VALID_MATCHER_ADDRESS,
        capXLM: 0,
        expiresAt: FUTURE_DATE,
      });

    expect(res.status).toBe(400);
  });

  test("rejects past expiresAt", async () => {
    const pastDate = new Date(Date.now() - 1000).toISOString();
    const res = await request(app)
      .post("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        projectId: VALID_PROJECT_ID,
        matcherAddress: VALID_MATCHER_ADDRESS,
        capXLM: 1000,
        expiresAt: pastDate,
      });

    expect(res.status).toBe(400);
  });

  test("returns 404 when project does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // project not found

    const res = await request(app)
      .post("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({
        projectId: VALID_PROJECT_ID,
        matcherAddress: VALID_MATCHER_ADDRESS,
        capXLM: 1000,
        expiresAt: FUTURE_DATE,
      });

    expect(res.status).toBe(404);
  });
});

// ── GET /api/admin/matches ───────────────────────────────────────────────────
describe("GET /api/admin/matches", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 401 without auth", async () => {
    const res = await request(app).get("/api/admin/matches");
    expect(res.status).toBe(401);
  });

  test("lists all match pools", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...DB_MATCH_ROW, project_name: "Test Project" }],
    });

    const res = await request(app)
      .get("/api/admin/matches")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].projectName).toBe("Test Project");
    expect(res.body.data[0].progressPct).toBeDefined();
    expect(res.body.data[0].remainingXLM).toBeDefined();
  });

  test("filters by projectId", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get(`/api/admin/matches?projectId=${VALID_PROJECT_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/dm\.project_id = \$1/);
    expect(values[0]).toBe(VALID_PROJECT_ID);
  });

  test("filters by status", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app)
      .get("/api/admin/matches?status=expired")
      .set("Authorization", `Bearer ${adminToken()}`);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/dm\.status = \$1/);
  });

  test("rejects invalid status filter with 400", async () => {
    const res = await request(app)
      .get("/api/admin/matches?status=bogus")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(400);
  });
});

// ── PATCH /api/admin/matches/:id ─────────────────────────────────────────────
describe("PATCH /api/admin/matches/:id", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 401 without auth", async () => {
    const res = await request(app).patch(`/api/admin/matches/${VALID_MATCH_ID}`).send({});
    expect(res.status).toBe(401);
  });

  test("updates capXLM successfully", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [DB_MATCH_ROW] }) // SELECT existing
      .mockResolvedValueOnce({ rows: [{ ...DB_MATCH_ROW, cap_xlm: "20000.0000000" }] }); // UPDATE

    const res = await request(app)
      .patch(`/api/admin/matches/${VALID_MATCH_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ capXLM: 20000 });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("returns 404 when pool not found", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .patch(`/api/admin/matches/${VALID_MATCH_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({ capXLM: 20000 });

    expect(res.status).toBe(404);
  });

  test("returns 400 when no updatable fields provided", async () => {
    pool.query.mockResolvedValueOnce({ rows: [DB_MATCH_ROW] });

    const res = await request(app)
      .patch(`/api/admin/matches/${VALID_MATCH_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`)
      .send({});

    expect(res.status).toBe(400);
  });
});

// ── DELETE /api/admin/matches/:id ────────────────────────────────────────────
describe("DELETE /api/admin/matches/:id", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns 401 without auth", async () => {
    const res = await request(app).delete(`/api/admin/matches/${VALID_MATCH_ID}`);
    expect(res.status).toBe(401);
  });

  test("cancels pool (sets status to cancelled)", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...DB_MATCH_ROW, status: "cancelled" }],
    });

    const res = await request(app)
      .delete(`/api/admin/matches/${VALID_MATCH_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("cancelled");

    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/status = 'cancelled'/);
    expect(values[0]).toBe(VALID_MATCH_ID);
  });

  test("returns 404 when pool does not exist", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .delete(`/api/admin/matches/${VALID_MATCH_ID}`)
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(404);
  });
});
