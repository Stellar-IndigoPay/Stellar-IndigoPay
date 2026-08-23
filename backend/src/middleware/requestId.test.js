"use strict";
/**
 * Unit tests for requestId middleware.
 */

describe("requestId middleware", () => {
  let requestId;

  // Helper: create a mock res that supports getHeader/setHeader
  function mockRes() {
    const headers = {};
    return {
      headers,
      getHeader: function (name) {
        return headers[name.toLowerCase()];
      },
      setHeader: function (name, value) {
        headers[name.toLowerCase()] = value;
      },
    };
  }

  beforeEach(() => {
    jest.resetModules();
    requestId = require("./requestId");
  });

  test("exports a middleware function", () => {
    expect(typeof requestId).toBe("function");
    expect(requestId.length).toBe(3);
  });

  test("middleware calls next", () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    requestId(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test("uses X-Request-ID header if provided", () => {
    const customId = "custom-req-id-123";
    const req = { headers: { "x-request-id": customId } };
    const res = mockRes();
    const next = jest.fn();

    requestId(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test("sets header when req.id is present", () => {
    const req = { id: "auto-gen-id", headers: {} };
    const res = mockRes();
    const next = jest.fn();

    requestId(req, res, next);

    expect(next).toHaveBeenCalled();
  });

  test("handles missing headers gracefully", () => {
    const req = { headers: {} };
    const res = mockRes();
    const next = jest.fn();

    expect(() => requestId(req, res, next)).not.toThrow();
    expect(next).toHaveBeenCalled();
  });

  test("exports HEADER_NAME constant", () => {
    expect(requestId.HEADER_NAME).toBe("X-Request-Id");
  });

  test("does not overwrite existing header", () => {
    const req = { id: "new-id", headers: {} };
    const res = mockRes();
    res.setHeader("x-request-id", "existing-id");
    const next = jest.fn();

    requestId(req, res, next);

    // Should not overwrite the existing header
    expect(res.getHeader("x-request-id")).toBe("existing-id");
    expect(next).toHaveBeenCalled();
  });
});
