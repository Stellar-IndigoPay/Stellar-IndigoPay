"use strict";

/**
 * backend/test/properties/harness/generators.js
 *
 * Value generators for the property suites. Everything is driven by the
 * seeded Rng — no Math.random, no clock, no globals — so generated inputs are
 * a pure function of (seed, iteration index).
 *
 * Sizes are deliberately bounded (see ../README.md "Performance"): the goal
 * is broad invariant coverage per unit of CI time, not exhaustive depth;
 * nightly runs scale iterations instead of input sizes.
 */

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";
// Includes the pipe delimiter (the audit-chain canonicalization hazard),
// JSON punctuation and non-ASCII to stress encoding paths.
const TEXT_ALPHABET = (
  LOWER + UPPER + DIGITS + "|:,{}\"'-_/\\ \u00e9\u00fc\u4e16"
).split("");

/**
 * Random digit string with no leading zero.
 *
 * @param {import("./rng").Rng} rng
 * @param {number} minLen
 * @param {number} maxLen
 * @returns {string}
 */
function digitString(rng, minLen, maxLen) {
  const len = rng.int(minLen, maxLen);
  let out = String(rng.int(1, 9));
  for (let i = 1; i < len; i += 1) out += String(rng.int(0, 9));
  return out;
}

/**
 * Exact decimal amount string: integer part of up to `maxIntDigits` digits,
 * fractional part of up to `maxFracDigits` digits. Built digit-by-digit so
 * no value ever passes through an IEEE-754 double.
 *
 * @param {import("./rng").Rng} rng
 * @param {{maxIntDigits?: number, maxFracDigits?: number}} [opts]
 * @returns {string}
 */
function decimalString(rng, opts = {}) {
  const maxIntDigits = opts.maxIntDigits ?? 12;
  const maxFracDigits = opts.maxFracDigits ?? 7;
  const intPart =
    rng.chance(0.08) ? "0" : digitString(rng, 1, maxIntDigits);
  let fracPart = "";
  if (maxFracDigits > 0 && rng.chance(0.7)) {
    fracPart = "";
    for (let i = 0; i < rng.int(1, maxFracDigits); i += 1) {
      fracPart += String(rng.int(0, 9));
    }
    // Sometimes keep trailing zeros so trimming logic is exercised.
    if (!rng.chance(0.3)) fracPart = fracPart.replace(/0+$/, "");
  }
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

/**
 * A small exact integer Number (never past MAX_SAFE_INTEGER) to exercise the
 * `typeof value === "number"` input path of the projection helpers.
 *
 * @param {import("./rng").Rng} rng
 * @param {number} [max]
 * @returns {number}
 */
function smallNumber(rng, max = 1000000) {
  return rng.int(0, max);
}

/**
 * Free-form text that may include delimiters, quotes, spaces and unicode.
 *
 * @param {import("./rng").Rng} rng
 * @param {number} minLen
 * @param {number} maxLen
 * @returns {string}
 */
function text(rng, minLen, maxLen) {
  const len = rng.int(minLen, maxLen);
  let out = "";
  for (let i = 0; i < len; i += 1) out += rng.pick(TEXT_ALPHABET);
  return out;
}

/**
 * Lowercase hex string (transaction hashes, addresses).
 *
 * @param {import("./rng").Rng} rng
 * @param {number} len
 * @returns {string}
 */
function hexText(rng, len) {
  const alphabet = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i += 1) out += alphabet[rng.int(0, 15)];
  return out;
}

/**
 * ISO-8601 timestamp string within a bounded range (2020-2030).
 *
 * @param {import("./rng").Rng} rng
 * @returns {string}
 */
function isoTimestamp(rng) {
  const ms = Date.UTC(2020, 0, 1) + rng.int(0, 10 * 365 * 24 * 3600 * 1000);
  return new Date(ms).toISOString();
}

/**
 * Array of distinct generated elements (distinctness enforced by generator
 * index embedding, not retry loops — keeps generation total and fast).
 *
 * @template T
 * @param {import("./rng").Rng} rng
 * @param {number} minLen
 * @param {number} maxLen
 * @param {(rng: import("./rng").Rng, i: number) => T} gen
 * @returns {T[]}
 */
function arrayOf(rng, minLen, maxLen, gen) {
  const len = rng.int(minLen, maxLen);
  const out = new Array(len);
  for (let i = 0; i < len; i += 1) out[i] = gen(rng, i);
  return out;
}

module.exports = {
  DIGITS,
  TEXT_ALPHABET,
  arrayOf,
  decimalString,
  digitString,
  hexText,
  isoTimestamp,
  smallNumber,
  text,
};
