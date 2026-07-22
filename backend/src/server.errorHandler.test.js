"use strict";

/**
 * Unit tests for the central error-handling middleware in server.js.
 * Exercised directly against `app.errorHandler` (rather than through a
 * live HTTP request) so Sentry-capture behavior can be asserted precisely
 * per error class:
 *   - 4xx AppError                  → structured response, no Sentry
 *   - 5xx AppError                  → structured response, Sentry captured
 *   - non-AppError 4xx (e.g. csurf) → best-effort structured response, no Sentry
 *   - truly unhandled error         → generic 500, message redacted, Sentry captured
 */

const Sentry = require("@sentry/node");
const app = require("./server");
const { AppError } = require("./errors");

const { errorHandler } = app;

function mockReq(overrides = {}) {
  return { path: "/api/projects/proj-1", method: "GET", ...overrides };
}

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

describe("errorHandler", () => {
  let captureSpy;

  beforeEach(() => {
    captureSpy = jest.spyOn(Sentry, "captureException").mockImplementation(() => {});
  });

  afterEach(() => {
    captureSpy.mockRestore();
  });

  test("a 4xx AppError returns its structured JSON and is not sent to Sentry", () => {
    const res = mockRes();
    errorHandler(new AppError("PROJECT_NOT_FOUND"), mockReq(), res, () => {});

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: { code: "PROJECT_NOT_FOUND", message: "Project not found" },
    });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test("a 4xx AppError with metadata includes it in the response", () => {
    const res = mockRes();
    errorHandler(
      new AppError("VALIDATION_ERROR", { field: "amount" }),
      mockReq(),
      res,
      () => {},
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        field: "amount",
      },
    });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test("a 5xx AppError is still returned structured but IS sent to Sentry, fingerprinted by code", () => {
    const res = mockRes();
    errorHandler(new AppError("DB_ERROR"), mockReq(), res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: { code: "DB_ERROR", message: "Database error" },
    });
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith(
      expect.any(AppError),
      expect.objectContaining({ extra: { errorCode: "DB_ERROR" } }),
    );
  });

  test("a non-AppError 4xx (e.g. csurf) is reported with its own status/message and skips Sentry", () => {
    const res = mockRes();
    const csrfErr = new Error("invalid csrf token");
    csrfErr.status = 403;

    errorHandler(csrfErr, mockReq(), res, () => {});

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({
      error: { code: "FORBIDDEN", message: "invalid csrf token" },
    });
    expect(captureSpy).not.toHaveBeenCalled();
  });

  test("an unhandled error redacts the message, defaults to 500, and is sent to Sentry", () => {
    const res = mockRes();
    const dbErr = new Error("connect ECONNREFUSED 127.0.0.1:5432");

    errorHandler(dbErr, mockReq(), res, () => {});

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({
      error: { code: "INTERNAL_ERROR", message: "Internal server error" },
    });
    expect(res.body.error.message).not.toContain("ECONNREFUSED");
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(captureSpy).toHaveBeenCalledWith(
      dbErr,
      expect.objectContaining({ extra: { errorCode: "INTERNAL_ERROR" } }),
    );
  });
});
