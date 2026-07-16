"use strict";

const { AppError, ERROR_CODES, sendAppError } = require("./errors");

describe("ERROR_CODES", () => {
  test("every code has a numeric HTTP status and a non-empty message", () => {
    for (const [code, def] of Object.entries(ERROR_CODES)) {
      expect(typeof def.status).toBe("number");
      expect(def.status).toBeGreaterThanOrEqual(400);
      expect(def.status).toBeLessThan(600);
      expect(typeof def.message).toBe("string");
      expect(def.message.length).toBeGreaterThan(0);
      // sanity: code keys are SCREAMING_SNAKE_CASE
      expect(code).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });

  test("includes the full taxonomy required by the issue", () => {
    const required = [
      "UNAUTHORIZED",
      "FORBIDDEN",
      "TOKEN_EXPIRED",
      "TOKEN_REVOKED",
      "PROJECT_NOT_FOUND",
      "DONATION_NOT_FOUND",
      "PROFILE_NOT_FOUND",
      "VERIFICATION_NOT_FOUND",
      "TX_NOT_FOUND",
      "VALIDATION_ERROR",
      "INVALID_ADDRESS",
      "INVALID_TX_HASH",
      "DUPLICATE_DONATION",
      "DUPLICATE_SUBSCRIPTION",
      "RATE_LIMITED",
      "INTERNAL_ERROR",
      "DB_ERROR",
      "RPC_ERROR",
      "CONTRACT_PAUSED",
      "PROJECT_PAUSED",
      "INSUFFICIENT_BADGE",
    ];
    for (const code of required) {
      expect(ERROR_CODES).toHaveProperty(code);
    }
  });

  test("matches the exact status/message pinned by the issue for key codes", () => {
    expect(ERROR_CODES.PROJECT_NOT_FOUND).toEqual({
      status: 404,
      message: "Project not found",
    });
    expect(ERROR_CODES.VALIDATION_ERROR).toEqual({
      status: 400,
      message: "Validation failed",
    });
    expect(ERROR_CODES.TX_NOT_FOUND).toEqual({
      status: 400,
      message: "Transaction not found on Stellar",
    });
    expect(ERROR_CODES.RATE_LIMITED).toEqual({
      status: 429,
      message: "Too many requests",
    });
    expect(ERROR_CODES.RPC_ERROR).toEqual({
      status: 502,
      message: "Soroban RPC unavailable",
    });
  });
});

describe("AppError", () => {
  test("sets code, status, and message from the taxonomy", () => {
    const err = new AppError("PROJECT_NOT_FOUND");
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("PROJECT_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toBe("Project not found");
  });

  test("stores metadata separately from the canonical message", () => {
    const err = new AppError("VALIDATION_ERROR", {
      field: "email",
      detail: "must be a valid email",
    });
    expect(err.message).toBe("Validation failed");
    expect(err.metadata).toEqual({
      field: "email",
      detail: "must be a valid email",
    });
  });

  test("defaults metadata to an empty object", () => {
    const err = new AppError("FORBIDDEN");
    expect(err.metadata).toEqual({});
  });

  test("falls back to INTERNAL_ERROR for an unknown code", () => {
    const err = new AppError("NOT_A_REAL_CODE");
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.status).toBe(500);
    expect(err.message).toBe("Internal server error");
  });

  describe("toJSON", () => {
    test("nests code and message under `error`", () => {
      const err = new AppError("DONATION_NOT_FOUND");
      expect(err.toJSON()).toEqual({
        error: { code: "DONATION_NOT_FOUND", message: "Donation not found" },
      });
    });

    test("spreads metadata alongside code and message", () => {
      const err = new AppError("VALIDATION_ERROR", { field: "amount" });
      expect(err.toJSON()).toEqual({
        error: {
          code: "VALIDATION_ERROR",
          message: "Validation failed",
          field: "amount",
        },
      });
    });

    test("is what JSON.stringify uses automatically", () => {
      const err = new AppError("RATE_LIMITED", { retryAfter: 42 });
      expect(JSON.parse(JSON.stringify(err))).toEqual({
        error: {
          code: "RATE_LIMITED",
          message: "Too many requests",
          retryAfter: 42,
        },
      });
    });
  });
});

describe("sendAppError", () => {
  function mockRes() {
    return {
      statusCode: null,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
  }

  test("sets the status from the error code and the structured JSON body", () => {
    const res = mockRes();
    sendAppError(res, "UNAUTHORIZED", { reason: "Missing token" });

    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({
      error: {
        code: "UNAUTHORIZED",
        message: "Authentication required",
        reason: "Missing token",
      },
    });
  });

  test("works with no metadata", () => {
    const res = mockRes();
    sendAppError(res, "RATE_LIMITED");

    expect(res.statusCode).toBe(429);
    expect(res.body).toEqual({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    });
  });
});
