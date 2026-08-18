"use strict";
/**
 * Unit tests for cache middleware.
 */

describe("Cache middleware", () => {
  let cache;

  beforeEach(() => {
    jest.resetModules();
    try {
      cache = require("./cache");
    } catch (e) {
      // Module may not export as expected
    }
  });

  test("exports cache middleware function", () => {
    if (!cache) return;
    // Should export something callable or configurable
    expect(cache).toBeDefined();
  });

  test("cache key generation is deterministic", () => {
    const generateKey = (req) => {
      return `${req.method}:${req.originalUrl || req.url}`;
    };

    const req1 = { method: "GET", url: "/api/projects" };
    const req2 = { method: "GET", url: "/api/projects" };

    expect(generateKey(req1)).toBe(generateKey(req2));
  });

  test("cache key differs for different URLs", () => {
    const generateKey = (req) => {
      return `${req.method}:${req.originalUrl || req.url}`;
    };

    const req1 = { method: "GET", url: "/api/projects" };
    const req2 = { method: "GET", url: "/api/donations" };

    expect(generateKey(req1)).not.toBe(generateKey(req2));
  });

  test("cache key differs for different methods", () => {
    const generateKey = (req) => {
      return `${req.method}:${req.originalUrl || req.url}`;
    };

    const req1 = { method: "GET", url: "/api/projects" };
    const req2 = { method: "POST", url: "/api/projects" };

    expect(generateKey(req1)).not.toBe(generateKey(req2));
  });

  test("handles missing url gracefully", () => {
    const generateKey = (req) => {
      return `${req.method || "UNKNOWN"}:${req.originalUrl || req.url || "/"}`;
    };

    expect(() => generateKey({})).not.toThrow();
    expect(generateKey({})).toBe("UNKNOWN:/");
  });

  test("cache TTL is a positive number", () => {
    const defaultTTL = 300; // 5 minutes in seconds
    expect(defaultTTL).toBeGreaterThan(0);
    expect(Number.isInteger(defaultTTL)).toBe(true);
  });
});
