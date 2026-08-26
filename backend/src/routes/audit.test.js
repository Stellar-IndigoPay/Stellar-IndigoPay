"use strict";

/**
 * src/routes/audit.test.js
 *
 * Tests for the public audit-chain verification endpoints.
 *
 * The audit routes are public (no auth) but rate-limited.  These tests
 * exercise both the /verify/:table and /chain/:table endpoints using
 * mocked pg pool and auditChain modules so no real Postgres is needed.
 *
 * Integration tests of verifyChain against real data live in
 * auditChain.test.js and auditRetention.integration.test.js.
 */

const request = require("supertest");
const express = require("express");

// ── Mock setup ──────────────────────────────────────────────────────────

// Mock the pool module — each test sets mockPool.query before calling the
// endpoint so the route handler receives controlled responses.
jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

const mockPool = require("../db/pool");

// Mock auditChain.verifyChain so we can control the integrity verdict.
jest.mock("../services/auditChain", () => ({
  verifyChain: jest.fn(),
  GENESIS_PREV_HASH: "0",
}));

const { verifyChain } = require("../services/auditChain");

// We mount the route directly on a bare Express app without the Redis rate
// limiter middleware.  The rate-limiting behaviour is tested separately in
// rateLimiter.test.js and rateLimitConfig.test.js.

const router = require("./audit");

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/audit", router);
  app.use("/api/v1/audit", router);
  // 404 handler for unmatched routes.
  app.use((req, res) =>
    res.status(404).json({
      error: { code: "NOT_FOUND", message: `${req.method} ${req.path} not found` },
    }),
  );
  // Attach the central error handler for consistent responses.
  const { errorHandler } = require("../server");
  app.use(errorHandler);
  return app;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function makeChainRows(count, startId = 1) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const id = `r${startId + i}`;
    rows.push({
      id,
      actor: "admin",
      action: `action-${id}`,
      target_type: null,
      target_id: null,
      metadata: "{}",
      created_at: new Date(2026, 6, startId + i).toISOString(),
      prev_hash: i === 0 ? "0" : `hash-r${startId + i - 1}`,
      row_hash: `hash-${id}`,
    });
  }
  return rows;
}

/** Encode a row into the same base64 cursor the production code generates. */
function makeCursor(row) {
  return Buffer.from(
    JSON.stringify({ created_at: row.created_at, id: row.id }),
  ).toString("base64");
}

beforeEach(() => {
  jest.clearAllMocks();
});

// ── GET /api/audit/verify/:table ────────────────────────────────────────

describe("GET /api/audit/verify/:table", () => {
  it("returns valid:true for a clean chain", async () => {
    verifyChain.mockResolvedValue({
      valid: true,
      checked: 42,
      anchored: false,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.checked).toBe(42);
    expect(res.body.data.anchored).toBe(false);
  });

  it("detects a tampered chain and returns the first invalid id", async () => {
    verifyChain.mockResolvedValue({
      valid: false,
      firstInvalidId: "r17",
      checked: 100,
      anchored: false,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.firstInvalidId).toBe("r17");
  });

  it("reports anchored:true when verification resumed from a retention anchor", async () => {
    verifyChain.mockResolvedValue({
      valid: true,
      checked: 15,
      anchored: true,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.data.anchored).toBe(true);
  });

  it("rejects an unknown table with 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/unknown_table")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.detail).toMatch(/not available/);
  });

  it("returns 404 for a path without a table name", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/")
      .expect(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("v1 mount also works", async () => {
    verifyChain.mockResolvedValue({
      valid: true,
      checked: 3,
      anchored: false,
    });

    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/audit/verify/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
  });
});

// ── GET /api/audit/chain/:table ─────────────────────────────────────────

describe("GET /api/audit/chain/:table", () => {
  it("returns a full chain segment without ip_address", async () => {
    const rows = makeChainRows(3);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 3 })
      .mockResolvedValueOnce({ rows: [{ total: "3" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(3);

    // Every returned row must carry prev_hash and row_hash for chain-link
    // verification, and must NOT include ip_address.
    for (const row of res.body.data.rows) {
      expect(row).toHaveProperty("prev_hash");
      expect(row).toHaveProperty("row_hash");
      expect(row).toHaveProperty("actor");
      expect(row).toHaveProperty("action");
      expect(row).not.toHaveProperty("ip_address");
    }

    // ip_address is redacted from the response but declared in redactedFields.
    expect(res.body.data.redactedFields).toContain("ip_address");

    // Cursors are base64-encoded tuples (created_at, id), not raw ids.
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.total).toBe(3);
  });

  it("returns tuple-based nextCursor when hasMore is true", async () => {
    const rows = makeChainRows(4); // 4 rows with limit=3 → hasMore
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 4 })
      .mockResolvedValueOnce({ rows: [{ total: "100" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log?limit=3")
      .expect(200);

    expect(res.body.data.rows).toHaveLength(3);
    expect(res.body.data.hasMore).toBe(true);
    expect(res.body.data.nextCursor).toBeTruthy();

    // The cursor must decode to a proper {created_at, id} tuple.
    const cursor = JSON.parse(
      Buffer.from(res.body.data.nextCursor, "base64").toString("utf8"),
    );
    expect(cursor).toHaveProperty("created_at");
    expect(cursor).toHaveProperty("id");
    expect(cursor.id).toBe("r3");
  });

  it("accepts cursor-based from/to pagination using tuple cursors", async () => {
    const rows = makeChainRows(2, 1); // r1, r2
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ total: "50" }], rowCount: 1 });

    // Build a from-cursor from a known row.
    const fromCursor = makeCursor({ created_at: rows[0].created_at, id: "r0" });

    const app = makeApp();
    const res = await request(app)
      .get(`/api/audit/chain/admin_audit_log?from=${fromCursor}&limit=2`)
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(2);

    // Verify the SQL uses tuple-based keyset pagination.
    const sql = mockPool.query.mock.calls[0][0];
    expect(sql).toMatch(/\(created_at, id\) > \(\$1, \$2\)/);
  });

  it("rejects an invalid (non-base64) cursor gracefully", async () => {
    const rows = makeChainRows(2);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ total: "50" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log?from=not-valid-base64$$")
      .expect(200);

    // An invalid cursor is silently treated as no-cursor (full chain returned).
    expect(res.body.data.rows).toHaveLength(2);
    const sql = mockPool.query.mock.calls[0][0];
    // No WHERE clause since the cursor was discarded.
    expect(sql).not.toMatch(/WHERE/);
  });

  it("respects the limit parameter (capped at 500)", async () => {
    const rows = makeChainRows(2);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ total: "1000" }], rowCount: 1 });

    const app = makeApp();
    await request(app)
      .get("/api/audit/chain/admin_audit_log?limit=2")
      .expect(200);

    const values = mockPool.query.mock.calls[0][1];
    expect(values).toContain(3); // limit + 1
  });

  it("rejects an unknown table with 400", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/secret_ledger")
      .expect(400);

    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.detail).toMatch(/not available/);
  });

  it("returns empty rows for a table with no records", async () => {
    mockPool.query
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ total: "0" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(0);
    expect(res.body.data.redactedFields).toContain("ip_address");
    expect(res.body.data.prevCursor).toBeNull();
    expect(res.body.data.nextCursor).toBeNull();
    expect(res.body.data.total).toBe(0);
  });

  it("v1 mount also works for chain endpoint", async () => {
    const rows = makeChainRows(1);
    mockPool.query
      .mockResolvedValueOnce({ rows, rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ total: "1" }], rowCount: 1 });

    const app = makeApp();
    const res = await request(app)
      .get("/api/v1/audit/chain/admin_audit_log")
      .expect(200);

    expect(res.body.success).toBe(true);
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.redactedFields).toContain("ip_address");
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────

describe("audit routes edge cases", () => {
  it("handles verifyChain throwing an unexpected error", async () => {
    verifyChain.mockRejectedValue(new Error("DB connection lost"));

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/verify/admin_audit_log")
      .expect(500);

    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });

  it("handles chain query failure gracefully", async () => {
    mockPool.query.mockRejectedValue(new Error("relation does not exist"));

    const app = makeApp();
    const res = await request(app)
      .get("/api/audit/chain/admin_audit_log")
      .expect(500);

    expect(res.body.error.code).toBe("INTERNAL_ERROR");
  });
});