"use strict";
/**
 * Tests for backend/src/middleware/auth.js
 *
 * Security focus (issue #822): verify that the JWT auth path fails closed
 * when JWT_SECRET is absent rather than silently using a hardcoded fallback.
 */

// ── helpers ─────────────────────────────────────────────────────────────────

/** Reload the auth module with a fresh process.env snapshot. */
function loadAuth(envOverrides = {}) {
  jest.resetModules();
  const saved = { ...process.env };
  Object.assign(process.env, envOverrides);
  const auth = require("./auth");
  // Restore env after loading so other tests are unaffected.
  process.env = saved;
  return auth;
}

/** Minimal res mock for adminRequired tests. */
function buildRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  return res;
}

// ── getSecret / signToken / verifyToken fail-closed behaviour ────────────────

describe("getSecret() — fail-closed when JWT_SECRET is absent", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("throws when JWT_SECRET is unset and NODE_ENV is production", () => {
    const savedEnv = { ...process.env };
    delete process.env.JWT_SECRET;
    delete process.env.TEST_JWT_SECRET;
    process.env.NODE_ENV = "production";

    try {
      const { signToken } = require("./auth");
      expect(() => signToken({ sub: "admin-1" }, "15m")).toThrow(
        /JWT_SECRET environment variable is not set/,
      );
    } finally {
      process.env = savedEnv;
    }
  });

  it("throws when JWT_SECRET is unset and NODE_ENV is development (no TEST_JWT_SECRET)", () => {
    const savedEnv = { ...process.env };
    delete process.env.JWT_SECRET;
    delete process.env.TEST_JWT_SECRET;
    process.env.NODE_ENV = "development";

    try {
      const { signToken } = require("./auth");
      expect(() => signToken({ sub: "admin-1" }, "15m")).toThrow(
        /JWT_SECRET environment variable is not set/,
      );
    } finally {
      process.env = savedEnv;
    }
  });

  it("throws when JWT_SECRET is an empty string", () => {
    const savedEnv = { ...process.env };
    process.env.JWT_SECRET = "";
    delete process.env.TEST_JWT_SECRET;
    process.env.NODE_ENV = "development";

    try {
      const { signToken } = require("./auth");
      expect(() => signToken({ sub: "admin-1" }, "15m")).toThrow(
        /JWT_SECRET environment variable is not set/,
      );
    } finally {
      process.env = savedEnv;
    }
  });

  it("uses JWT_SECRET when it is set", () => {
    const savedEnv = { ...process.env };
    process.env.JWT_SECRET = "a-real-test-secret-32-chars-long!!";
    process.env.NODE_ENV = "test";

    try {
      const { signToken, verifyToken } = require("./auth");
      const token = signToken({ sub: "admin-1", jti: "jti-1" }, "15m");
      expect(typeof token).toBe("string");
      const decoded = verifyToken(token);
      expect(decoded.sub).toBe("admin-1");
    } finally {
      process.env = savedEnv;
    }
  });

  it("accepts TEST_JWT_SECRET in non-production environments", () => {
    const savedEnv = { ...process.env };
    delete process.env.JWT_SECRET;
    process.env.TEST_JWT_SECRET = "test-only-secret-for-non-prod";
    process.env.NODE_ENV = "test";

    try {
      const { signToken, verifyToken } = require("./auth");
      const token = signToken({ sub: "admin-2", jti: "jti-2" }, "15m");
      expect(typeof token).toBe("string");
      const decoded = verifyToken(token);
      expect(decoded.sub).toBe("admin-2");
    } finally {
      process.env = savedEnv;
    }
  });

  it("does NOT fall back to TEST_JWT_SECRET when NODE_ENV is production", () => {
    const savedEnv = { ...process.env };
    delete process.env.JWT_SECRET;
    process.env.TEST_JWT_SECRET = "test-only-secret-for-non-prod";
    process.env.NODE_ENV = "production";

    try {
      const { signToken } = require("./auth");
      expect(() => signToken({ sub: "admin-1" }, "15m")).toThrow(
        /JWT_SECRET environment variable is not set/,
      );
    } finally {
      process.env = savedEnv;
    }
  });
});

describe("verifyToken() — fail-closed when JWT_SECRET is absent", () => {
  it("throws when JWT_SECRET is unset (not a JWT error, a config error)", () => {
    const savedEnv = { ...process.env };
    delete process.env.JWT_SECRET;
    delete process.env.TEST_JWT_SECRET;
    process.env.NODE_ENV = "production";

    try {
      const { verifyToken } = require("./auth");
      expect(() => verifyToken("any.token.string")).toThrow(
        /JWT_SECRET environment variable is not set/,
      );
    } finally {
      process.env = savedEnv;
    }
  });
});

// ── adminRequired propagates missing-secret as 503 ──────────────────────────

describe("adminRequired() — returns 503 SERVICE_UNAVAILABLE when JWT_SECRET absent", () => {
  // Mock the db pool so adminRequired doesn't need a real Postgres connection.
  beforeAll(() => {
    jest.mock("../db/pool", () => ({
      query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    }));
  });

  afterAll(() => {
    jest.unmock("../db/pool");
  });

  it("responds 503 when JWT_SECRET is unset and a Bearer token is presented", async () => {
    const savedEnv = { ...process.env };
    delete process.env.JWT_SECRET;
    delete process.env.TEST_JWT_SECRET;
    process.env.NODE_ENV = "production";

    jest.resetModules();

    try {
      const { adminRequired } = require("./auth");
      const req = {
        get: (h) => (h === "X-Admin-Key" ? undefined : undefined),
        headers: { authorization: "Bearer some.fake.token" },
      };
      const res = buildRes();
      const next = jest.fn();

      await adminRequired(req, res, next);

      // sendAppError calls res.status(...).json(...)
      expect(res.status).toHaveBeenCalledWith(503);
      expect(next).not.toHaveBeenCalled();
    } finally {
      process.env = savedEnv;
    }
  });
});

// ── generateAccessToken round-trip (positive path) ──────────────────────────

describe("generateAccessToken() + verifyToken() round-trip", () => {
  it("issues and verifies a token when JWT_SECRET is set", () => {
    const savedEnv = { ...process.env };
    process.env.JWT_SECRET = "round-trip-test-secret-must-be-strong!";
    process.env.NODE_ENV = "test";

    jest.resetModules();

    try {
      const { generateAccessToken, verifyToken } = require("./auth");
      const token = generateAccessToken("admin-99", "admin");
      const decoded = verifyToken(token);
      expect(decoded.sub).toBe("admin-99");
      expect(decoded.role).toBe("admin");
      expect(typeof decoded.jti).toBe("string");
    } finally {
      process.env = savedEnv;
    }
  });
});

// ── Tokens signed with different secrets are rejected ───────────────────────

describe("verifyToken() rejects tokens signed with a different secret", () => {
  it("throws JsonWebTokenError when the signing and verifying secrets differ", () => {
    const savedEnv = { ...process.env };

    jest.resetModules();
    process.env.JWT_SECRET = "secret-A-used-for-signing";
    process.env.NODE_ENV = "test";
    const { signToken } = require("./auth");
    const token = signToken({ sub: "admin-1", jti: "jti-x" }, "15m");

    // Reload with a different secret — simulates secret rotation / forgery attempt.
    jest.resetModules();
    process.env.JWT_SECRET = "secret-B-different-from-A";
    const { verifyToken } = require("./auth");

    try {
      expect(() => verifyToken(token)).toThrow();
    } finally {
      process.env = savedEnv;
    }
  });
});
