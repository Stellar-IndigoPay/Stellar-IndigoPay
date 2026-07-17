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
 * On validation failure it returns HTTP 400 with a consistent error shape:
 *   {
 *     "error": "Validation failed",
 *     "details": [
 *       { "path": "fieldName", "message": "Error description" }
 *     ]
 *   }
 *
 * On success the parsed (and potentially coerced/defaulted) data replaces the
 * original request property so downstream handlers receive clean values.
 *
 * Note: Express 5 defines `req.query` as a getter-only property, so direct
 * assignment fails. This middleware uses Object.assign for query/params and
 * direct replacement for body.
 */
"use strict";

/**
 * @param {import("zod").ZodSchema} schema
 * @param {"body"|"query"|"params"} [source="body"]
 * @returns {import("express").RequestHandler}
 */
function validate(schema, source = "body") {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);

    if (!result.success) {
      const details = result.error.issues.map((issue) => ({
        path: issue.path.length > 0 ? issue.path.join(".") : source,
        message: issue.message,
      }));

      return res.status(400).json({
        error: "Validation failed",
        details,
      });
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
