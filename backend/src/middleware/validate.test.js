"use strict";

const { z } = require("zod");
const { AppError } = require("../errors");
const { validate } = require("./validate");

function mockReqRes(body) {
  const req = { body, query: {}, params: {} };
  const res = {
    _status: null,
    status(code) {
      this._status = code;
      return this;
    },
    // The middleware must never write the response itself — the central
    // error handler does that. Trip-wire: any regression to `sendAppError`
    // or `res.status().json()` will throw here, surfacing the test that
    // depends on the cross-cutting contract.
    json() {
      throw new Error("validate middleware must not call res.json");
    },
  };
  const next = jest.fn();
  return { req, res, next };
}

/**
 * Extract the AppError the middleware forwarded to `next()` on a failed
 * validation. Tests use this to assert on the structured payload the central
 * error handler will eventually serialise.
 */
function forwardedError(next) {
  expect(next).toHaveBeenCalledTimes(1);
  const err = next.mock.calls[0][0];
  expect(err).toBeInstanceOf(AppError);
  return err;
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

      // Success path: next() invoked with no error argument.
      expect(next).toHaveBeenCalledTimes(1);
      expect(next.mock.calls[0]).toHaveLength(0);
      expect(req.body).toEqual({ name: "Alice", age: 30 });
    });

    test("forwards a SCHEMA_VALIDATION_ERROR AppError (422) for invalid data", () => {
      const { req, res, next } = mockReqRes({ name: "", age: -1 });
      validate(schema)(req, res, next);

      // The middleware writes nothing to `res`; the central error handler does.
      expect(res._status).toBeNull();

      const err = forwardedError(next);
      expect(err.code).toBe("SCHEMA_VALIDATION_ERROR");
      expect(err.status).toBe(422);
      expect(err.message).toBe("Validation failed");
      expect(err.metadata.details).toBeInstanceOf(Array);
      expect(err.metadata.details.length).toBeGreaterThanOrEqual(1);
    });

    test("reports multiple validation errors together", () => {
      const { req, res, next } = mockReqRes({ name: "", age: -5 });
      validate(schema)(req, res, next);

      const err = forwardedError(next);
      expect(err.status).toBe(422);
      expect(err.metadata.details.length).toBeGreaterThanOrEqual(2);
    });

    test("falls back to the source name when an issue has no path", () => {
      // Root-level refinement failures (e.g. an invalid value supplied for
      // the whole body) come back from zod with `issue.path === []`. The
      // middleware should attribute them to the source (`"body"`) so the UI
      // can localise the error instead of seeing an empty path.
      const rootSchema = z.string({ invalid_type_error: "must be a string" });
      const req = { body: 123, query: {}, params: {} }; // wrong root-level type
      const res = { _status: null, status() { return this; }, json() { throw new Error("never called"); } };
      const next = jest.fn();

      validate(rootSchema)(req, res, next);

      const err = forwardedError(next);
      expect(err.code).toBe("SCHEMA_VALIDATION_ERROR");
      expect(err.metadata.details[0].path).toBe("body");
      expect(err.metadata.details[0].message).toMatch(/string/i);
    });
  });

  describe("query validation", () => {
    const schema = z.object({
      limit: z.coerce.number().int().positive().optional().default(20),
    });

    test("attaches SCHEMA_VALIDATION_ERROR to next on invalid query", () => {
      const { req, res, next } = mockReqRes({});
      req.query = { limit: "abc" };
      validate(schema, "query")(req, res, next);

      // The `res.json` trip-wire in mockReqRes is the assertion here:
      // any regression the middleware writes the response inline would
      // throw before reaching the next assertions below.
      const err = forwardedError(next);
      expect(err.status).toBe(422);
      expect(err.code).toBe("SCHEMA_VALIDATION_ERROR");
    });

    test("applies defaults on valid query and does not call next with an error", () => {
      const { req, res, next } = mockReqRes({});
      req.query = {};
      validate(schema, "query")(req, res, next);

      expect(next).not.toHaveBeenCalledWith(expect.any(Error));
      expect(req.query.limit).toBe(20);
    });
  });

  describe("params validation", () => {
    const schema = z.object({
      id: z.string().uuid("Invalid UUID"),
    });

    test("attaches SCHEMA_VALIDATION_ERROR to next on invalid params", () => {
      const { req, res, next } = mockReqRes({});
      req.params = { id: "not-a-uuid" };
      validate(schema, "params")(req, res, next);

      const err = forwardedError(next);
      expect(err.status).toBe(422);
      expect(err.code).toBe("SCHEMA_VALIDATION_ERROR");
      expect(err.metadata.details[0].path).toBe("id");
    });

    test("passes valid params", () => {
      const { req, res, next } = mockReqRes({});
      req.params = { id: "550e8400-e29b-41d4-a716-446655440000" };
      validate(schema, "params")(req, res, next);

      expect(next).not.toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
