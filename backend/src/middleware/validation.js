"use strict";

/**
 * src/middleware/validation.js
 *
 * Request-body sanitisation helpers (used when *building* Zod schemas that
 * strip / reject HTML from user-supplied text fields).
 *
 * Middleware entry points live in `validate.js`. Use `validate(schema)` for
 * every body / query / params shape — the older `validateBody` alias has been
 * removed so the whole API emits the same `{ error: { code, message, details } }`
 * shape with `details` as an array `[{ path, message }]` (closes #550).
 */

const { z } = require("zod");

function containsHtml(value) {
  return /<[^>]+>/i.test(value || "");
}

function stripHtml(value) {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizedStringField({
  required = false,
  minLength = 1,
  maxLength,
  message = "must not contain HTML",
} = {}) {
  let schema = z
    .string()
    .trim()
    .refine((value) => !containsHtml(value), { message });

  if (maxLength) {
    schema = schema.refine((value) => value.length <= maxLength, {
      message: `must be at most ${maxLength} characters`,
    });
  }

  if (required) {
    schema = schema.refine((value) => value.length >= minLength, {
      message: `must be at least ${minLength} characters`,
    });
  }

  schema = schema.transform((value) => stripHtml(value));

  if (!required) {
    schema = schema.optional();
  }

  return schema;
}

module.exports = {
  containsHtml,
  sanitizedStringField,
  stripHtml,
};
