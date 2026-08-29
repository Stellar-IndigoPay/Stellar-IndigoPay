"use strict";

/**
 * src/validators/sanitize.js
 *
 * Shared sanitization transform for text fields. Applied server-side to all
 * free-text inputs before they are stored, to neutralise stored-XSS vectors,
 * Unicode homoglyph spoofing, and bidirectional-text-override attacks.
 *
 * Rules:
 *   1. Strip bidirectional control characters (U+202A–U+202E, U+2066–U+2069,
 *      U+200E/U+200F, U+061C).
 *   2. Normalize Unicode to NFC (canonical composition) so confusable
 *      composed/decomposed forms collapse to a single representation.
 *   3. Strip HTML tags from plain-text fields.
 *   4. Truncate at the schema-defined max length rather than rejecting.
 */

const { z } = require("zod");

const BIDI_RE =
  /[\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C]/g;

// Strip complete script/style blocks (including their content) plus any
// remaining standalone HTML tags. This neutralises stored-XSS vectors where
// an attacker embeds executable markup in a plain-text field.
const HTML_TAG_RE =
  /<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<[^>]*>/gi;

/**
 * Sanitize a plain-text string.
 *
 * @param {string} value - raw input
 * @param {number} [maxLength] - truncation limit (applied after sanitization)
 * @returns {string}
 */
function sanitize(value, maxLength) {
  if (typeof value !== "string") return value;

  let out = value
    // 1. Strip bidirectional control characters.
    .replace(BIDI_RE, "")
    // 2. Normalize to NFC.
    .normalize("NFC")
    // 3. Strip HTML tags.
    .replace(HTML_TAG_RE, "");

  // 4. Truncate at the schema-defined max length.
  if (typeof maxLength === "number" && maxLength > 0 && out.length > maxLength) {
    out = out.slice(0, maxLength);
  }

  return out;
}

/**
 * Zod transform that sanitizes a string field. Use as:
 *   z.string().transform(sanitizeTransform(maxLength))
 *
 * @param {number} [maxLength] - truncation limit
 * @returns {(value: string) => string}
 */
function sanitizeTransform(maxLength) {
  return (value) => sanitize(value, maxLength);
}

/**
 * Build a Zod schema that sanitizes a string field and then validates it.
 *
 * Zod v4's `.transform()` returns a `ZodPipe` which does not expose the
 * string validators (`.min()`, `.max()`, `.regex()`, `.trim()`), so the
 * sanitization transform must be applied via `.pipe()` and the length/format
 * checks run on the sanitized value inside the piped schema.
 *
 * @param {number} maxLength - truncation + max-length limit
 * @param {object} [options]
 * @param {number} [options.minLength] - minimum length (checked after sanitize)
 * @param {RegExp} [options.regex] - format check applied after sanitize
 * @param {string} [options.regexMessage] - message for the regex check
 * @param {boolean} [options.trim] - trim surrounding whitespace before length checks
 * @param {boolean} [options.truncate] - truncate at maxLength instead of rejecting
 *   (default true). Set to false for fields that must reject over-length input.
 * @param {string} [options.minMessage] - message for the min-length check
 * @param {string} [options.maxMessage] - message for the max-length check
 * @returns {import("zod").ZodPipe}
 */
function sanitizedString(maxLength, options = {}) {
  const {
    minLength,
    regex,
    regexMessage,
    trim,
    truncate = true,
    minMessage,
    maxMessage,
    rejectHtml = false,
  } = options;

  let base = z.string();
  // Some strict fields (e.g. profile display names) must reject HTML outright
  // rather than silently strip it, so the raw value is checked before the
  // sanitization transform runs.
  if (rejectHtml) {
    base = base.refine(
      (val) => !/<[^>]*>/.test(val),
      { message: "HTML tags are not allowed" },
    );
  }

  let inner = base;
  if (trim) inner = inner.trim();
  if (minLength != null) inner = inner.min(minLength, minMessage);
  inner = inner.max(maxLength, maxMessage);
  if (regex) inner = inner.regex(regex, regexMessage);

  const transform = truncate
    ? sanitizeTransform(maxLength)
    : (value) => sanitize(value);

  return base.transform(transform).pipe(inner);
}

module.exports = {
  sanitize,
  sanitizeTransform,
  sanitizedString,
  BIDI_RE,
  HTML_TAG_RE,
};
