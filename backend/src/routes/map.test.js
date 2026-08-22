"use strict";

/**
 * Integration tests for GET /api/map
 *
 * The endpoint returns geo-located project data for the world map widget.
 * It supports optional ?category and ?status filters and is cached in Redis
 * for 600 seconds (TTL).  These tests mock the DB pool and Redis layer so
 * the suite is fast, hermetic, and CI-friendly.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("../services/redis", () => ({
  get: jest.fn(),
  set: jest.fn(),
  deletePattern: jest.fn(),
}));

// The cache middleware also imports these metric counters — stub them so the
// module loads cleanly without a real Prometheus registry.
jest.mock("../services/metrics", () => ({
  cacheHits: { inc: jest.fn() },
  cacheMisses: { inc: jest.fn() },
  cacheCoalesced: { inc: jest.fn() },
}));

const pool = require("../db/pool");
const redis = require("../services/redis");
const express = require("express");
const request = require("supertest");
const mapRouter = require("./map");
const { AppError } = require("../errors");

// ── App factory ──────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/map", mapRouter);
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res
      .status(err.status || 500)
      .json({ error: err.message || "Internal server error" });
  });
  return app;
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

const MOCK_PROJECT_ROW = {
  id: "proj-1",
  name: "Amazon Reforestation",
  category: "Reforestation",
  location: "Brazil",
  latitude: "-3.4653",
  longitude: "-62.2159",
  raised_xlm: "5000",
  co2_offset_kg: 50000,
  status: "active",
  verified: true,
};

const MOCK_SOLAR_ROW = {
  id: "proj-2",
  name: "Solar Farm Kenya",
  category: "Solar Energy",
  location: "Kenya",
  latitude: "-1.2921",
  longitude: "36.8219",
  raised_xlm: "2000",
  co2_offset_kg: 20000,
  status: "active",
  verified: false,
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("GET /api/map", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.resetAllMocks();
    // Default: cold cache (no cached entry in Redis)
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue(null);
  });

  // ── 1. Basic response shape ────────────────────────────────────────────────

  test("returns 200 with success flag and data array", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });

  test("serialises all required coordinate fields", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    const project = res.body.data[0];
    expect(project.id).toBe("proj-1");
    expect(project.name).toBe("Amazon Reforestation");
    expect(project.category).toBe("Reforestation");
    expect(project.location).toBe("Brazil");
    expect(project.latitude).toBe(-3.4653);
    expect(project.longitude).toBe(-62.2159);
    expect(project.raisedXLM).toBe("5000");
    expect(project.co2OffsetKg).toBe(50000);
    expect(project.status).toBe("active");
    expect(project.verified).toBe(true);
  });

  test("returns empty data array when no projects match", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get("/api/map").expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual([]);
  });

  test("returns multiple projects", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [MOCK_PROJECT_ROW, MOCK_SOLAR_ROW],
    });

    const res = await request(app).get("/api/map").expect(200);

    expect(res.body.data).toHaveLength(2);
    expect(res.body.data[0].id).toBe("proj-1");
    expect(res.body.data[1].id).toBe("proj-2");
  });

  // ── 2. Default status filter ───────────────────────────────────────────────

  test("defaults to active status when no status param is given", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    await request(app).get("/api/map").expect(200);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("status = 'active'");
  });

  // ── 3. Status filter ──────────────────────────────────────────────────────

  test("filters by status=completed", async () => {
    const completedRow = { ...MOCK_PROJECT_ROW, status: "completed" };
    pool.query.mockResolvedValueOnce({ rows: [completedRow] });

    const res = await request(app).get("/api/map?status=completed").expect(200);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("status = $");
    expect(params).toContain("completed");
    expect(res.body.data[0].status).toBe("completed");
  });

  test("filters by status=paused", async () => {
    const pausedRow = { ...MOCK_PROJECT_ROW, status: "paused" };
    pool.query.mockResolvedValueOnce({ rows: [pausedRow] });

    await request(app).get("/api/map?status=paused").expect(200);

    const [, params] = pool.query.mock.calls[0];
    expect(params).toContain("paused");
  });

  test("ignores invalid status value and falls back to active default", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    await request(app).get("/api/map?status=invalid").expect(200);

    const [sql, params] = pool.query.mock.calls[0];
    // Should use the literal 'active' clause, not a parameterised one
    expect(sql).toContain("status = 'active'");
    expect(params).not.toContain("invalid");
  });

  // ── 4. Category filter ────────────────────────────────────────────────────

  test("filters by a valid category", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app)
      .get("/api/map?category=Reforestation")
      .expect(200);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("category = $");
    expect(params).toContain("Reforestation");
    expect(res.body.data[0].category).toBe("Reforestation");
  });

  test("ignores an invalid category value (not in VALID_CATEGORIES)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/api/map?category=InvalidCategory").expect(200);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).not.toContain("category = $");
    expect(params).not.toContain("InvalidCategory");
  });

  test("applies both category and status filters simultaneously", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_SOLAR_ROW] });

    await request(app)
      .get("/api/map?category=Solar+Energy&status=active")
      .expect(200);

    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toContain("category = $");
    expect(sql).toContain("status = $");
    expect(params).toContain("Solar Energy");
    expect(params).toContain("active");
  });

  // ── 5. Coordinate-only projects ───────────────────────────────────────────

  test("query always requires non-null latitude and longitude", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await request(app).get("/api/map").expect(200);

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toContain("latitude IS NOT NULL");
    expect(sql).toContain("longitude IS NOT NULL");
  });

  // ── 6. Numeric type coercion ──────────────────────────────────────────────

  test("latitude and longitude are returned as numbers, not strings", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    const project = res.body.data[0];
    expect(typeof project.latitude).toBe("number");
    expect(typeof project.longitude).toBe("number");
  });

  test("co2OffsetKg is returned as an integer", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    expect(Number.isInteger(res.body.data[0].co2OffsetKg)).toBe(true);
  });

  test("verified field is a boolean", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    expect(typeof res.body.data[0].verified).toBe("boolean");
  });

  test("raisedXLM falls back to '0' when the DB column is null", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [{ ...MOCK_PROJECT_ROW, raised_xlm: null }],
    });

    const res = await request(app).get("/api/map").expect(200);

    expect(res.body.data[0].raisedXLM).toBe("0");
  });

  // ── 7. Caching headers ────────────────────────────────────────────────────

  test("sets X-Cache: MISS and Cache-Control on a cold cache response", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    expect(res.headers["x-cache"]).toBe("MISS");
    expect(res.headers["cache-control"]).toMatch(/public/);
    expect(res.headers["cache-control"]).toMatch(/max-age=600/);
  });

  test("sets X-Cache: HIT and returns cached data on a warm cache response", async () => {
    const cachedBody = {
      success: true,
      data: [
        {
          id: "cached-1",
          name: "Cached Project",
          category: "Reforestation",
          location: "Brazil",
          latitude: -3.4653,
          longitude: -62.2159,
          raisedXLM: "1000",
          co2OffsetKg: 5000,
          status: "active",
          verified: true,
        },
      ],
    };
    redis.get.mockResolvedValue(cachedBody);

    const res = await request(app).get("/api/map").expect(200);

    expect(res.headers["x-cache"]).toBe("HIT");
    expect(res.body).toEqual(cachedBody);
    // DB must not be touched on a cache hit
    expect(pool.query).not.toHaveBeenCalled();
  });

  test("stores the response in Redis after a cache miss", async () => {
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    await request(app).get("/api/map").expect(200);

    expect(redis.set).toHaveBeenCalledTimes(1);
    const [, body, ttl] = redis.set.mock.calls[0];
    expect(body.success).toBe(true);
    expect(ttl).toBe(600);
  });

  // ── 8. Error handling ─────────────────────────────────────────────────────

  test("propagates a DB error as a 500 response", async () => {
    pool.query.mockRejectedValueOnce(new Error("DB connection refused"));

    const res = await request(app).get("/api/map").expect(500);

    expect(res.body.error).toBeDefined();
  });

  test("continues to serve when Redis cache read fails", async () => {
    redis.get.mockRejectedValueOnce(new Error("Redis timeout"));
    pool.query.mockResolvedValueOnce({ rows: [MOCK_PROJECT_ROW] });

    const res = await request(app).get("/api/map").expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
  });
});
