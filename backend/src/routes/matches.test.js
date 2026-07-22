/**
 * src/routes/matches.test.js
 */
"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const express = require("express");
const request = require("supertest");
const pool = require("../db/pool");
const matchesRouter = require("./matches");

const VALID_PROJECT_ID = "11111111-1111-1111-1111-111111111111";
const VALID_MATCH_ID = "22222222-2222-2222-2222-222222222222";
const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

const ACTIVE_MATCH_ROW = {
  id: VALID_MATCH_ID,
  project_id: VALID_PROJECT_ID,
  matcher_address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  cap_xlm: "10000.0000000",
  multiplier: 2,
  matched_xlm: "1500.0000000",
  expires_at: FUTURE_DATE,
  status: "active",
  effective_status: "active",
  progress_pct: "15.00",
  created_at: new Date().toISOString(),
};

const EXPIRED_MATCH_ROW = {
  ...ACTIVE_MATCH_ROW,
  id: "33333333-3333-3333-3333-333333333333",
  expires_at: new Date(Date.now() - 1000).toISOString(),
  status: "expired",
  effective_status: "expired",
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/matches", matchesRouter);
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: { code: err.code || "INTERNAL_ERROR", message: err.message } });
  });
  return app;
}

// ── GET /api/matches ─────────────────────────────────────────────────────────
describe("GET /api/matches", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns all matches when no filter specified", async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW, EXPIRED_MATCH_ROW] });

    const res = await request(app).get("/api/matches");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(2);
  });

  test("includes computed fields: progressPct, remainingXLM, effectiveStatus", async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW] });

    const res = await request(app).get("/api/matches");

    expect(res.status).toBe(200);
    const match = res.body.data[0];
    expect(match.progressPct).toBe(15);
    expect(match.remainingXLM).toBe("8500.0000000");
    expect(match.effectiveStatus).toBe("active");
  });

  test("filters by projectId", async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW] });

    const res = await request(app).get(`/api/matches?projectId=${VALID_PROJECT_ID}`);

    expect(res.status).toBe(200);
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/dm\.project_id = \$1/);
    expect(values[0]).toBe(VALID_PROJECT_ID);
  });

  test("?active=true adds status and expires_at filters", async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW] });

    await request(app).get("/api/matches?active=true");

    const [sql] = pool.query.mock.calls[0];
    expect(sql).toMatch(/dm\.status = 'active'/);
    expect(sql).toMatch(/dm\.expires_at > NOW\(\)/);
    expect(sql).toMatch(/dm\.matched_xlm < dm\.cap_xlm/);
  });

  test("returns only active matches when ?active=true is used", async () => {
    pool.query.mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW] });

    const res = await request(app).get("/api/matches?active=true");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe("active");
  });

  test("rejects invalid projectId with 400", async () => {
    const res = await request(app).get("/api/matches?projectId=not-a-uuid");
    expect(res.status).toBe(400);
  });
});

// ── GET /api/matches/:id/stats ───────────────────────────────────────────────
describe("GET /api/matches/:id/stats", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
  });

  test("returns matching impact metrics", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW] }) // match lookup
      .mockResolvedValueOnce({
        rows: [{
          match_transactions: 5,
          total_matched: "7500.0000000",
          donors_reached: 4,
          avg_match_xlm: "1500.0000000",
        }],
      });

    const res = await request(app).get(`/api/matches/${VALID_MATCH_ID}/stats`);

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const data = res.body.data;
    expect(data.matchId).toBe(VALID_MATCH_ID);
    expect(data.matchTransactions).toBe(5);
    expect(data.donorsReached).toBe(4);
    expect(data.totalMatchedXLM).toBe("7500.0000000");
    expect(data.avgMatchXLM).toBe("1500.0000000");
  });

  test("returns 404 when match pool not found", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).get(`/api/matches/${VALID_MATCH_ID}/stats`);

    expect(res.status).toBe(404);
  });

  test("uses correct LIKE pattern for matching donations", async () => {
    pool.query
      .mockResolvedValueOnce({ rows: [ACTIVE_MATCH_ROW] })
      .mockResolvedValueOnce({
        rows: [{ match_transactions: 0, total_matched: "0", donors_reached: 0, avg_match_xlm: "0" }],
      });

    await request(app).get(`/api/matches/${VALID_MATCH_ID}/stats`);

    const [, statsValues] = pool.query.mock.calls[1];
    expect(statsValues[1]).toBe(`match-%-${VALID_MATCH_ID}`);
  });

  test("returns 400 for malformed UUID", async () => {
    const res = await request(app).get("/api/matches/not-a-uuid/stats");
    expect(res.status).toBe(400);
  });
});
