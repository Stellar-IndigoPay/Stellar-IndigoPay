/**
 * src/middleware/validate.js
 *
 * Generic Zod-based request validation middleware.
 *
 * Usage:
 *   router.post("/", validate(donationSchema), handler);
 *   router.get("/", validate(leaderboardQuerySchema, "query"), handler);
 *   router.get("/:id", validate(paramsSchema, "params"), handler);
 *
 * On validation failure it forwards a `SCHEMA_VALIDATION_ERROR` (HTTP 422)
 * to the central error handler so the response shape matches every other
 * error in the API:
 *   {
 *     "error": {
 *       "code": "SCHEMA_VALIDATION_ERROR",
 *       "message": "Validation failed",
 *       "details": [
 *         { "path": "fieldName", "message": "Error description" }
 *       ]
 *     }
 *   }
 *
 * Routing through `next(err)` (rather than writing the response inline via
 * `sendAppError`) means schema failures get the same structured
 * `request_error` log line, request-level correlation id, and central
 * handling as every other `AppError`. It also matches the pattern used by
 * the sibling `backend/src/middleware/validation.js`.
 *
 * On success the parsed (and potentially coerced/defaulted) data replaces the
 * original request property so downstream handlers receive clean values.
 *
 * Note: Express 5 defines `req.query` as a getter-only property, so direct
 * assignment fails. This middleware uses Object.assign for query/params and
 * direct replacement for body.
 */
"use strict";

const { AppError } = require("../errors");

/**
 * @param {import("zod").ZodSchema} schema
 * @param {"body"|"query"|"params"} [source="body"]
 * @returns {import("express").RequestHandler}
 */
function validate(schema, source = "body") {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : source,
        message: issue.message,
        // Zod's per-issue `code` (e.g. `invalid_type`, `too_small`,
        // `invalid_string`, `custom`) lets UI render category-specific
        // copy without re-parsing the human message. Carried alongside
        // `path` and `message` so the array is strictly more informative
        // than the legacy object-map shape ever was.
        code: issue.code,
      }));

      return next(new AppError("SCHEMA_VALIDATION_ERROR", { details }));
    }

    if (source === "body") {
      req.body = result.data;
    } else {
      // Express 5/routerman defines req.query and req.params as prototype
      // getters without setters. Override with an own property descriptor.
      Object.defineProperty(req, source, {
        value: result.data,
        configurable: true,
        writable: true,
        enumerable: true,
      });
    }
    next();
  };
}

module.exports = { validate };
