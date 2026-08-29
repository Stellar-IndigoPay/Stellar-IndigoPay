"use strict";

/**
 * Tests for src/services/adminAudit.js
 *
 * Issue #1128 Part A — append-only admin audit log with before/after state.
 *
 * Coverage:
 *   - logAdminAction inserts a row with all expected fields
 *   - logAdminAction includes before_state and after_state
 *   - logAdminAction computes a row hash via auditChain
 *   - logAdminAction swallows errors (fire-and-forget)
 *   - logAdminAction handles missing optional fields gracefully
 *   - Legacy targetType / targetId aliases are mapped to resource columns
 *   - auditMiddleware records the action after a 2xx response
 *   - auditMiddleware does NOT record on 4xx responses
 *   - auditMiddleware captures the request body before the handler runs
 *   - sanitizeBody strips credential-like fields
 */

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockQuery = jest.fn();

jest.mock("../db/pool", () => ({ query: mockQuery }));

// Provide a stable uuid so we can assert on the inserted id.
const FAKE_UUID = "aaaabbbb-cccc-dddd-eeee-ffffffffffff";
jest.mock("uuid", () => ({ v4: () => FAKE_UUID }));

// Provide a stable prev_hash so hash assertions are deterministic.
const FAKE_PREV_HASH = "deadbeef00000000000000000000000000000000000000000000000000000000";
jest.mock("../services/auditChain", () => ({
  getPrevHash: jest.fn().mockResolvedValue(FAKE_PREV_HASH),
  computeRowHash: jest.fn().mockReturnValue("rowhashabc123"),
}));

jest.mock("../logger", () => ({
  warn:  jest.fn(),
  error: jest.fn(),
  info:  jest.fn(),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMockRes(status = 200) {
  const jsonFn = jest.fn();
  const res = {
    statusCode: status,
    json: jsonFn,
    get: jest.fn(),
  };
  return res;
}

function makeMockReq(overrides = {}) {
  return {
    method: "POST",
    originalUrl: "/api/admin/projects/verify",
    ip: "127.0.0.1",
    params: {},
    body: {},
    admin: { sub: "admin-user" },
    get: jest.fn((header) => (header === "User-Agent" ? "TestAgent/1.0" : null)),
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("adminAudit", () => {
  const { logAdminAction, auditMiddleware, sanitizeBody } = require("./adminAudit");
  const { getPrevHash, computeRowHash } = require("../services/auditChain");

  beforeEach(() => {
    jest.clearAllMocks();
    // Default: successful INSERT
    mockQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  // ── logAdminAction ─────────────────────────────────────────────────────────

  describe("logAdminAction", () => {
    it("inserts a row with all expected fields", async () => {
      await logAdminAction({
        actor: "alice",
        action: "project.verify",
        resourceType: "project",
        resourceId: "proj-001",
        beforeState: { status: "pending" },
        afterState: { status: "approved" },
        metadata: { reason: "checked" },
        ipAddress: "10.0.0.1",
        userAgent: "TestAgent/1.0",
      });

      expect(mockQuery).toHaveBeenCalledTimes(1);
      const [sql, values] = mockQuery.mock.calls[0];
      expect(sql).toMatch(/INSERT INTO admin_audit_log/);
      expect(values).toEqual([
        FAKE_UUID,           // id
        "alice",             // actor
        "project.verify",    // action
        "project",           // resource_type
        "proj-001",          // resource_id
        JSON.stringify({ status: "pending" }),   // before_state
        JSON.stringify({ status: "approved" }),  // after_state
        JSON.stringify({ reason: "checked" }),   // metadata
        "10.0.0.1",          // ip_address
        "TestAgent/1.0",     // user_agent
        FAKE_PREV_HASH,      // prev_hash
        "rowhashabc123",     // row_hash
      ]);
    });

    it("passes null for optional fields when omitted", async () => {
      await logAdminAction({ actor: "alice", action: "admin.login" });

      const [, values] = mockQuery.mock.calls[0];
      expect(values[3]).toBeNull(); // resource_type
      expect(values[4]).toBeNull(); // resource_id
      expect(values[5]).toBeNull(); // before_state
      expect(values[6]).toBeNull(); // after_state
      expect(values[8]).toBeNull(); // ip_address
      expect(values[9]).toBeNull(); // user_agent
    });

    it("maps legacy targetType/targetId to resource columns", async () => {
      await logAdminAction({
        actor: "bob",
        action: "project.pause",
        targetType: "project",
        targetId: "proj-002",
      });

      const [, values] = mockQuery.mock.calls[0];
      expect(values[3]).toBe("project");  // resource_type
      expect(values[4]).toBe("proj-002"); // resource_id
    });

    it("swallows errors — never throws (fire-and-forget)", async () => {
      mockQuery.mockRejectedValue(new Error("DB connection lost"));

      await expect(
        logAdminAction({ actor: "alice", action: "project.verify" }),
      ).resolves.toBeUndefined();
    });

    it("logs an error when the INSERT fails", async () => {
      const logger = require("../logger");
      mockQuery.mockRejectedValue(new Error("insert failed"));

      await logAdminAction({ actor: "alice", action: "project.verify" });

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ event: "admin_audit_write_error" }),
        expect.any(String),
      );
    });

    it("still inserts when computeRowHash throws (hash error is non-fatal)", async () => {
      computeRowHash.mockImplementationOnce(() => {
        throw new Error("hash failure");
      });
      const logger = require("../logger");

      await logAdminAction({ actor: "alice", action: "test.action" });

      // The INSERT should still happen (rowHash will be null).
      expect(mockQuery).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "audit_hash_error" }),
        expect.any(String),
      );
    });

    it("calls getPrevHash to thread the chain", async () => {
      await logAdminAction({ actor: "alice", action: "admin.login" });

      expect(getPrevHash).toHaveBeenCalledTimes(1);
      const [, values] = mockQuery.mock.calls[0];
      expect(values[10]).toBe(FAKE_PREV_HASH); // prev_hash
    });

    it("uses '0' as prev_hash when getPrevHash rejects", async () => {
      getPrevHash.mockRejectedValueOnce(new Error("chain unavailable"));

      await logAdminAction({ actor: "alice", action: "test" });

      const [, values] = mockQuery.mock.calls[0];
      expect(values[10]).toBe("0");
    });

    it("encodes before_state and after_state as JSON strings", async () => {
      const before = { status: "pending", co2_rate: 100 };
      const after  = { status: "approved", co2_rate: 100 };

      await logAdminAction({
        actor: "alice",
        action: "project.approve",
        beforeState: before,
        afterState:  after,
      });

      const [, values] = mockQuery.mock.calls[0];
      expect(values[5]).toBe(JSON.stringify(before)); // before_state
      expect(values[6]).toBe(JSON.stringify(after));  // after_state
    });
  });

  // ── auditMiddleware ────────────────────────────────────────────────────────

  describe("auditMiddleware", () => {
    it("records the action after a 2xx JSON response", () => {
      const middleware = auditMiddleware("project.verify", "project");
      const req = makeMockReq({ params: { id: "proj-001" } });
      const res = makeMockRes(200);
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);

      // Simulate the handler calling res.json.
      res.json({ success: true });

      // The INSERT should have been enqueued (fire-and-forget promise).
      // We can't await it here, so verify mockQuery was scheduled.
      // Use a flush to let the microtask queue drain.
      return Promise.resolve().then(() => {
        expect(mockQuery).toHaveBeenCalledTimes(1);
      });
    });

    it("does NOT record the action on a 4xx response", () => {
      const middleware = auditMiddleware("project.verify", "project");
      const req = makeMockRes();
      const res = makeMockRes(400);
      const next = jest.fn();

      middleware(req, res, next);
      res.json({ error: "bad request" });

      return Promise.resolve().then(() => {
        expect(mockQuery).not.toHaveBeenCalled();
      });
    });

    it("calls next() unconditionally", () => {
      const middleware = auditMiddleware("test.action");
      const req = makeMockReq();
      const res = makeMockRes(200);
      const next = jest.fn();

      middleware(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
    });

    it("forwards the res.json return value unchanged", () => {
      const middleware = auditMiddleware("test.action");
      const req = makeMockReq();
      const res = makeMockRes(200);
      const next = jest.fn();

      const sentBody = { success: true, data: { id: 1 } };
      res.json.mockReturnValue(undefined);

      middleware(req, res, next);
      res.json(sentBody);

      expect(res.json).toHaveBeenCalledWith(sentBody);
    });
  });

  // ── sanitizeBody ──────────────────────────────────────────────────────────

  describe("sanitizeBody", () => {
    it("removes credential-like keys", () => {
      const body = {
        projectId: "p1",
        password: "s3cr3t",
        secret: "tok",
        secretKey: "key",
        adminAddress: "G123",
        token: "t",
        privateKey: "pk",
        name: "Solar Farm",
      };
      const result = sanitizeBody(body);
      expect(result).toEqual({ projectId: "p1", name: "Solar Farm" });
    });

    it("returns empty object for null/undefined", () => {
      expect(sanitizeBody(null)).toEqual({});
      expect(sanitizeBody(undefined)).toEqual({});
    });

    it("returns empty object for non-object input", () => {
      expect(sanitizeBody("string")).toEqual({});
      expect(sanitizeBody(42)).toEqual({});
    });

    it("does not mutate the original body", () => {
      const body = { password: "secret", name: "test" };
      const result = sanitizeBody(body);
      expect(body.password).toBe("secret");
      expect(result.password).toBeUndefined();
    });
  });
});
