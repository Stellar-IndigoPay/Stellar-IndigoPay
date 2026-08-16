"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

// In-memory fixture the mocked pool.query reads from. Tests mutate
// `mockFixtureRows` in beforeEach/inside the test body before making a request.
// The mock understands the same keyset-pagination shape the route builds:
// the last value in `values` is always the LIMIT, and when the query text
// contains the cursor predicate, the second-to-last/third-to-last values
// are the (created_at, id) cursor to resume after.
// NOTE: must be named with a `mock` prefix — Jest's mock-hoisting babel
// plugin only allows a jest.mock() factory to close over out-of-scope
// variables whose name starts with "mock" (case-insensitive), since
// jest.mock() calls are hoisted above regular declarations.
let mockFixtureRows = [];
const captured = { query: null, values: null };

jest.mock("../../db/pool", () => ({
  query: jest.fn((text, values) => {
    captured.query = text;
    captured.values = values || [];

    const hasCursor = text.includes("(created_at, id) <");
    // /export/json has no LIMIT clause at all (it's not paginated) — only
    // treat the trailing value as a batch limit when the query text
    // actually has one, otherwise return everything from the cursor on.
    const hasLimit = text.includes(" LIMIT $");
    let startIndex = 0;

    if (hasCursor) {
      const cursorIdIdx = hasLimit ? values.length - 2 : values.length - 1;
      const cursorId = values[cursorIdIdx];
      const idx = mockFixtureRows.findIndex((r) => r.id === cursorId);
      startIndex = idx === -1 ? mockFixtureRows.length : idx + 1;
    }

    const endIndex = hasLimit
      ? startIndex + values[values.length - 1]
      : mockFixtureRows.length;

    return Promise.resolve({
      rows: mockFixtureRows.slice(startIndex, endIndex),
    });
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

// Single-row fixture used by the basic/filter tests below — mirrors the
// original test fixture shape.
const SINGLE_ROW_FIXTURE = [
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

describe("GET /api/admin/audit-log/export/csv", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    captured.query = null;
    captured.values = null;
    mockFixtureRows = SINGLE_ROW_FIXTURE;
    delete process.env.AUDIT_EXPORT_BATCH_SIZE;
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
    // Trailing value is the per-batch LIMIT, appended after the filters.
    expect(captured.values).toEqual(["admin", "login", expect.any(Number)]);
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

  it("streams a large filtered result set across multiple batches", async () => {
    const TOTAL_ROWS = 2500;
    const BATCH_SIZE = 400;
    process.env.AUDIT_EXPORT_BATCH_SIZE = String(BATCH_SIZE);

    // Newest first, matching ORDER BY created_at DESC, id DESC.
    mockFixtureRows = Array.from({ length: TOTAL_ROWS }, (_, i) => ({
      id: `e${String(TOTAL_ROWS - i).padStart(6, "0")}`,
      actor: "admin",
      action: "login",
      target_type: null,
      target_id: null,
      metadata: null,
      ip_address: "127.0.0.1",
      created_at: new Date(2026, 0, 1, 0, 0, TOTAL_ROWS - i).toISOString(),
    }));

    const pool = require("../../db/pool");
    const queryCallsBefore = pool.query.mock.calls.length;

    const res = await request(app)
      .get("/api/admin/audit-log/export/csv")
      .set("Authorization", `Bearer ${adminToken()}`);

    expect(res.status).toBe(200);

    const lines = res.text.trim().split("\n");
    expect(lines[0]).toBe(
      "id,actor,action,target_type,target_id,metadata,ip_address,created_at",
    );
    // header + every fixture row, nothing dropped or duplicated across
    // batch boundaries.
    expect(lines.length).toBe(TOTAL_ROWS + 1);

    // 2500 rows at 400/batch: 6 full batches (2400 rows) + 1 short batch of
    // 100 rows. The short batch is < batchSize, which terminates the loop
    // immediately (no extra empty-result call needed) — so this is exactly
    // ceil(2500/400) = 7 pool.query calls, proving this went through
    // multiple round-trips rather than one unbounded query.
    const queryCallsDuringExport = pool.query.mock.calls.length - queryCallsBefore;
    expect(queryCallsDuringExport).toBe(Math.ceil(TOTAL_ROWS / BATCH_SIZE));

    // Every batch query after the first carries the cursor predicate.
    const cursoredCalls = pool.query.mock.calls
      .slice(queryCallsBefore)
      .filter(([text]) => text.includes("(created_at, id) <"));
    expect(cursoredCalls.length).toBe(queryCallsDuringExport - 1);
  });
});

describe("GET /api/admin/audit-log/export/json", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    mockFixtureRows = SINGLE_ROW_FIXTURE;
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
    expect(second.body.error).toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: expect.any(Number),
    });
    expect(second.body.error.retryAfter).toBeGreaterThan(0);
  });
});