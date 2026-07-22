"use strict";

const { z } = require("zod");
const { validate } = require("./validate");

function mockReqRes(body) {
  const req = { body, query: {}, params: {} };
  const res = {
    _json: null,
    _status: 200,
    status(code) {
      this._status = code;
      return this;
    },
    json(payload) {
      this._json = payload;
      return this;
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

describe("validate middleware", () => {
  describe("body validation", () => {
    const schema = z.object({
      name: z.string().min(1, "Name is required"),
      age: z.coerce.number().int().positive("Age must be positive"),
    });

    test("passes valid data and replaces req.body with parsed values", () => {
      const { req, res, next } = mockReqRes({ name: "Alice", age: "30" });
      validate(schema)(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.body).toEqual({ name: "Alice", age: 30 });
    });

    test("returns 400 with details for invalid data", () => {
      const { req, res, next } = mockReqRes({ name: "", age: -1 });
      validate(schema)(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(400);
      expect(res._json.error).toBe("Validation failed");
      expect(res._json.details).toBeInstanceOf(Array);
      expect(res._json.details.length).toBeGreaterThanOrEqual(1);
    });

    test("returns 400 for missing required fields", () => {
      const { req, res, next } = mockReqRes({});
      validate(schema)(req, res, next);

      expect(res._status).toBe(400);
      expect(res._json.error).toBe("Validation failed");
      expect(res._json.details.length).toBe(2);
    });

    test("reports multiple validation errors together", () => {
      const { req, res, next } = mockReqRes({ name: "", age: -5 });
      validate(schema)(req, res, next);

      expect(res._status).toBe(400);
      expect(res._json.details.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe("query validation", () => {
    const schema = z.object({
      limit: z.coerce.number().int().positive().optional().default(20),
    });

    test("validates query parameters", () => {
      const { req, res, next } = mockReqRes({});
      req.query = { limit: "abc" };
      validate(schema, "query")(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(400);
    });

    test("applies defaults on valid query", () => {
      const { req, res, next } = mockReqRes({});
      req.query = {};
      validate(schema, "query")(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(req.query.limit).toBe(20);
    });
  });

  describe("params validation", () => {
    const schema = z.object({
      id: z.string().uuid("Invalid UUID"),
    });

    test("validates params", () => {
      const { req, res, next } = mockReqRes({});
      req.params = { id: "not-a-uuid" };
      validate(schema, "params")(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res._status).toBe(400);
      expect(res._json.details[0].path).toBe("id");
    });

    test("passes valid params", () => {
      const { req, res, next } = mockReqRes({});
      req.params = { id: "550e8400-e29b-41d4-a716-446655440000" };
      validate(schema, "params")(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe("error shape", () => {
    test("does not expose stack traces", () => {
      const { req, res, next } = mockReqRes({ name: 123 });
      const schema = z.object({ name: z.string() });
      validate(schema)(req, res, next);

      expect(res._json).not.toHaveProperty("stack");
      expect(res._json.details).toBeInstanceOf(Array);
      expect(res._json.details[0]).toHaveProperty("path");
      expect(res._json.details[0]).toHaveProperty("message");
    });
  });
});
