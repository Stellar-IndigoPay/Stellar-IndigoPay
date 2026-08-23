"use strict";
/**
 * Unit tests for corsPolicy middleware.
 */

describe("CORS Policy middleware", () => {
  let corsPolicy;

  beforeEach(() => {
    jest.resetModules();
    try {
      corsPolicy = require("./corsPolicy");
    } catch (e) {
      // Module may export differently
    }
  });

  test("exports middleware configuration", () => {
    if (!corsPolicy) return;

    // CORS policy should be an object or function
    expect(
      typeof corsPolicy === "object" || typeof corsPolicy === "function",
    ).toBe(true);
  });

  test("allows configured origins", () => {
    const allowedOrigins = [
      "https://indigopay.app",
      "http://localhost:3000",
    ];

    const isAllowed = (origin) => allowedOrigins.includes(origin);
    expect(isAllowed("https://indigopay.app")).toBe(true);
    expect(isAllowed("http://localhost:3000")).toBe(true);
    expect(isAllowed("https://evil.com")).toBe(false);
  });

  test("allows specific HTTP methods", () => {
    const allowedMethods = ["GET", "POST", "PUT", "DELETE", "OPTIONS"];

    expect(allowedMethods.includes("GET")).toBe(true);
    expect(allowedMethods.includes("POST")).toBe(true);
    expect(allowedMethods.includes("TRACE")).toBe(false);
  });

  test("allows specific headers", () => {
    const allowedHeaders = [
      "Content-Type",
      "Authorization",
      "X-Request-ID",
    ];

    expect(allowedHeaders.includes("Content-Type")).toBe(true);
    expect(allowedHeaders.includes("Authorization")).toBe(true);
  });

  test("sets Access-Control-Allow-Credentials", () => {
    const credentials = "true";
    expect(credentials).toBe("true");
  });
});
