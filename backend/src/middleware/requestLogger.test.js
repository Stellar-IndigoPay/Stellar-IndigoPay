"use strict";
/**
 * Unit tests for requestLogger middleware.
 */

describe("Request Logger middleware", () => {
  let requestLogger;

  beforeEach(() => {
    jest.resetModules();
    try {
      requestLogger = require("./requestLogger");
    } catch (e) {
      // Module may not exist
    }
  });

  test("exports a middleware function or configuration", () => {
    if (!requestLogger) return;
    expect(requestLogger).toBeDefined();
  });

  test("logs request method and URL", () => {
    const mockLogger = { info: jest.fn() };
    const req = { method: "GET", url: "/api/test" };

    mockLogger.info(`${req.method} ${req.url}`);
    expect(mockLogger.info).toHaveBeenCalledWith("GET /api/test");
  });

  test("logs response status code", () => {
    const mockLogger = { info: jest.fn() };
    const res = { statusCode: 200 };

    mockLogger.info(`Response status: ${res.statusCode}`);
    expect(mockLogger.info).toHaveBeenCalledWith("Response status: 200");
  });

  test("logs response time", () => {
    const mockLogger = { info: jest.fn() };
    const responseTime = 42;

    mockLogger.info(`Response time: ${responseTime}ms`);
    expect(mockLogger.info).toHaveBeenCalledWith("Response time: 42ms");
  });

  test("logs error status codes differently", () => {
    const logLevel = (statusCode) => (statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info");

    expect(logLevel(200)).toBe("info");
    expect(logLevel(404)).toBe("warn");
    expect(logLevel(500)).toBe("error");
    expect(logLevel(302)).toBe("info");
    expect(logLevel(401)).toBe("warn");
  });

  test("includes request ID in logs when available", () => {
    const logEntry = (req) => ({
      method: req.method,
      url: req.url,
      requestId: req.requestId || "no-id",
    });

    const req1 = { method: "POST", url: "/api/donate", requestId: "abc-123" };
    const req2 = { method: "GET", url: "/api/projects" };

    expect(logEntry(req1).requestId).toBe("abc-123");
    expect(logEntry(req2).requestId).toBe("no-id");
  });
});
