/**
 * shared/validation.fixtures.js
 *
 * Generates the parity test-case matrix used by both
 * `backend/src/validators/schemas.parity.test.js` and
 * `frontend/__tests__/validation.parity.test.ts`. Both suites run this
 * exact same case list against their own copy of the schemas built from
 * shared/validation.js, so "identical input → identical accept/reject
 * decision on both sides" is enforced by CI on every change, not just
 * asserted by hand (acceptance criteria, Issue #90-follow-up).
 *
 * Pure JS, no Node-only APIs — loads under plain Node (backend/Jest) and
 * under jsdom (frontend/Jest) unchanged.
 */
"use strict";

const VALID_ADDRESS = "G" + "A".repeat(55);
const VALID_TX_HASH = "a".repeat(64);

// A small linear-congruential PRNG so the fuzz cases are reproducible
// across runs/environments instead of relying on Math.random().
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
}

/** Table-driven amount-string cases: [value, shouldBeValid]. */
const AMOUNT_CASES = [
  ["1", true],
  ["1.0000000", true],
  ["1.0000001", true],
  ["0.9999999", false], // below AMOUNT_MIN
  ["0", false],
  ["-1", false],
  ["abc", false],
  ["", false],
  ["1.00000001", false], // 8 decimals, exceeds AMOUNT_MAX_DECIMALS
  ["10000000", true], // exactly AMOUNT_MAX
  ["10000000.0000001", false], // just over AMOUNT_MAX
  ["1,000", false], // comma not allowed
  ["1e5", false], // scientific notation not allowed
  [" 1", false], // leading whitespace
  ["1 ", false], // trailing whitespace
  ["01", true], // leading zero, still >= 1
  ["1.", false], // trailing dot with no digits
  [".5", false], // no leading digit
];

/** Table-driven message-length cases: [value, shouldBeValid]. */
const MESSAGE_CASES = [
  ["", true],
  ["x".repeat(100), true],
  ["x".repeat(101), false],
  ["😀".repeat(100), true], // 100 code points, each 2 UTF-16 units
  ["😀".repeat(101), false],
  ["a".repeat(99) + "😀", true], // 100 code points total
];

/** Table-driven Stellar-address cases: [value, shouldBeValid]. */
const ADDRESS_CASES = [
  [VALID_ADDRESS, true],
  [VALID_ADDRESS.toLowerCase(), false],
  [VALID_ADDRESS.slice(0, -1), false], // too short
  [VALID_ADDRESS + "A", false], // too long
  ["M" + "A".repeat(55), false], // wrong prefix
  ["", false],
];

/** Table-driven transaction-hash cases: [value, shouldBeValid]. */
const TX_HASH_CASES = [
  [VALID_TX_HASH, true],
  [VALID_TX_HASH.toUpperCase(), true],
  [VALID_TX_HASH.slice(0, -1), false],
  [VALID_TX_HASH + "a", false],
  ["z".repeat(64), false],
  ["", false],
];

/** Random decimal-ish strings for the amount fuzz matrix. */
function fuzzAmountStrings(count, seed) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const intDigits = 1 + Math.floor(rng() * 10);
    let intPart = "";
    for (let d = 0; d < intDigits; d += 1) {
      intPart += Math.floor(rng() * 10);
    }
    const hasDecimal = rng() < 0.7;
    let value = intPart;
    if (hasDecimal) {
      const decDigits = Math.floor(rng() * 10); // 0..9, sometimes over the 7-limit
      let decPart = "";
      for (let d = 0; d < decDigits; d += 1) {
        decPart += Math.floor(rng() * 10);
      }
      value = `${intPart}.${decPart}`;
    }
    // Occasionally corrupt the string to exercise the reject path too.
    if (rng() < 0.15) value = `-${value}`;
    if (rng() < 0.1) value = `${value}e2`;
    out.push(value);
  }
  return out;
}

/**
 * Builds the full parity matrix: a flat list of
 * { field, input, expected } entries, where `expected` is computed once
 * here (from the pure helpers, not from either schema) so both
 * environments are checked against an independent oracle.
 */
function buildParityMatrix({ seed = 42, fuzzCount = 200 } = {}) {
  const shared = require("./validation");
  const cases = [];

  for (const [value, expected] of AMOUNT_CASES) {
    cases.push({ field: "amount", input: value, expected });
  }
  for (const [value, expected] of MESSAGE_CASES) {
    cases.push({ field: "message", input: value, expected });
  }
  for (const [value, expected] of ADDRESS_CASES) {
    cases.push({ field: "address", input: value, expected });
  }
  for (const [value, expected] of TX_HASH_CASES) {
    cases.push({ field: "txHash", input: value, expected });
  }

  // Fuzz cases: expected value is derived from the same pure helpers the
  // schema itself uses, so this checks the schema wiring, not the math.
  for (const value of fuzzAmountStrings(fuzzCount, seed)) {
    const expected =
      shared.isValidDecimalString(value) &&
      shared.decimalPlaces(value) <= shared.RULES.AMOUNT_MAX_DECIMALS &&
      shared.compareDecimalStrings(value, shared.RULES.AMOUNT_MIN) >= 0 &&
      shared.compareDecimalStrings(value, shared.RULES.AMOUNT_MAX) <= 0;
    cases.push({ field: "amount", input: value, expected });
  }

  return cases;
}

module.exports = {
  VALID_ADDRESS,
  VALID_TX_HASH,
  AMOUNT_CASES,
  MESSAGE_CASES,
  ADDRESS_CASES,
  TX_HASH_CASES,
  fuzzAmountStrings,
  buildParityMatrix,
};
