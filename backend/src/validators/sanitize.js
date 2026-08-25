"use strict";

/**
 * src/validators/sanitize.js
 *
 * Shared sanitization helpers for text fields validated by Zod schemas.
 *
 * Guards against stored-XSS and Unicode spoofing vectors:
 *   - strips bidirectional control characters (e.g. U+202E RLO)
 *   - normalizes Unicode to NFC (canonical composition)
 *   - strips HTML tags from plain-text fields
 *   - truncates at the schema-defined max length rather than rejecting
 *
 * The returned Zod transform is applied to text fields in schemas.js.
 */

const { z } = require("zod");

// Bidirectional control characters that can reorder displayed text and
// disguise malicious links / project names.
const BIDI_CONTROL_RE =
  /[\u200E\u200F\u202A\u202B\u202C\u202D\u202E\u2066\u2067\u2068\u2069\u061C]/g;

// Zero-width characters that can be used for homoglyph / confusable attacks.
const ZERO_WIDTH_RE = /(?:\u200B|\u200C|\u200D|\uFEFF)/g;

// HTML/XML tags (including self-closing and with attributes).
const HTML_TAG_RE = /<\/?[a-zA-Z][^>]*>/g;

/**
 * Sanitize a single string value:
 *   1. strip bidirectional control characters
 *   2. strip zero-width characters
 *   3. normalize Unicode to NFC
 *   4. strip HTML tags
 *   5. collapse whitespace runs
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeString(value) {
  if (typeof value !== "string") return value;
  return value
    .replace(BIDI_CONTROL_RE, "")
    .replace(ZERO_WIDTH_RE, "")
    .normalize("NFC")
    .replace(HTML_TAG_RE, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a Zod transform that sanitizes a string and truncates it to the
 * given maximum length (rather than rejecting).
 *
 * @param {number} maxLength - Maximum allowed length after sanitization.
 * @returns {import("zod").ZodEffects<import("zod").ZodString, string, string>}
 */
function sanitize(maxLength) {
  return z
    .string()
    .transform((value) => {
      const cleaned = sanitizeString(value);
      return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
    });
}

module.exports = {
  sanitize,
  sanitizeString,
  BIDI_CONTROL_RE,
  ZERO_WIDTH_RE,
  HTML_TAG_RE,
};
