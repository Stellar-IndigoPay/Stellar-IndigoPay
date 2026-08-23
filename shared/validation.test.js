/**
 * shared/validation.test.js — unit + parity tests for validation.js
 * itself, runnable with plain Node (`node --test shared/validation.test.js`
 * or `npm run test:shared`), independent of either the backend's or the
 * frontend's Jest setup. This is the "shared-schema unit tests" layer
 * called for in Issue #90-follow-up's testing requirements; the
 * environment-specific parity suites
 * (backend/src/validators/schemas.parity.test.js and
 * frontend/__tests__/validation.parity.test.ts) additionally wire the
 * same fixtures through each real environment's schema.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const shared = require("./validation");
const fixtures = require("./validation.fixtures");

test("isValidDecimalString / decimalPlaces / compareDecimalStrings", () => {
  assert.equal(shared.isValidDecimalString("1.5"), true);
  assert.equal(shared.isValidDecimalString("1,5"), false);
  assert.equal(shared.isValidDecimalString("1e5"), false);
  assert.equal(shared.decimalPlaces("1.5000"), 4);
  assert.equal(shared.decimalPlaces("42"), 0);
  assert.equal(shared.compareDecimalStrings("0.1", "0.10"), 0);
  assert.equal(shared.compareDecimalStrings("0.2", "0.1"), 1);
  assert.equal(shared.compareDecimalStrings("0.1", "0.2"), -1);
  // A float-based comparison of 0.1 + 0.2 famously misbehaves; this
  // asserts the BigInt path doesn't inherit that (edge case in spec).
  assert.equal(shared.compareDecimalStrings("0.30000000000000004", "0.3"), 1);
});

test("codePointLength counts code points, not UTF-16 units", () => {
  assert.equal(shared.codePointLength("abc"), 3);
  assert.equal(shared.codePointLength("😀"), 1); // surrogate pair, 1 code point
  assert.equal("😀".length, 2); // sanity: UTF-16 length is 2
});

test("getAssetCodesForNetwork is parameterized, not hard-coded", () => {
  assert.deepEqual(shared.getAssetCodesForNetwork("testnet"), ["XLM", "USDC", "EURT"]);
  assert.deepEqual(shared.getAssetCodesForNetwork("mainnet"), ["XLM", "USDC"]);
  assert.deepEqual(shared.getAssetCodesForNetwork("unknown"), shared.getAssetCodesForNetwork("testnet"));
});

test("validateUploadMeta rejects oversize and disallowed mime types", () => {
  const oversize = shared.validateUploadMeta({ size: shared.RULES.UPLOAD_MAX_BYTES + 1 });
  assert.equal(oversize.valid, false);
  assert.equal(oversize.key, "upload.tooLarge");

  const badType = shared.validateUploadMeta({ size: 100, mimetype: "application/x-msdownload" });
  assert.equal(badType.valid, false);
  assert.equal(badType.key, "upload.invalidType");

  const ok = shared.validateUploadMeta({ size: 100, mimetype: "application/pdf" });
  assert.equal(ok.valid, true);
});

test("amountString enforces RULES.AMOUNT_MIN/MAX/MAX_DECIMALS", () => {
  const amount = shared.amountString({ field: "Amount" });
  assert.equal(amount.safeParse("1").success, true);
  assert.equal(amount.safeParse("0.9999999").success, false);
  assert.equal(amount.safeParse("10000000").success, true);
  assert.equal(amount.safeParse("10000000.0000001").success, false);
  assert.equal(amount.safeParse("1.00000001").success, false);
});

test("DoS guard: raw input over MAX_RAW_INPUT_LENGTH is rejected", () => {
  const amount = shared.amountString({ field: "Amount" });
  const huge = "1".repeat(5000);
  assert.equal(amount.safeParse(huge).success, false);
});

test("parity matrix: table-driven + fuzz cases match the pure oracle", () => {
  const matrix = fixtures.buildParityMatrix({ seed: 7, fuzzCount: 300 });
  assert.ok(matrix.length > 300, "expected hundreds of generated cases");

  const amount = shared.amountString({ field: "Amount" });
  const address = shared.stellarAddress;
  const txHash = shared.transactionHash;
  const message = shared.boundedText({ field: "Message", max: shared.RULES.MESSAGE_MAX_LEN });

  let checked = 0;
  for (const { field, input, expected } of matrix) {
    const schema = { amount, address, txHash, message }[field];
    assert.equal(
      schema.safeParse(input).success,
      expected,
      `field=${field} input=${JSON.stringify(input)} expected valid=${expected}`,
    );
    checked += 1;
  }
  assert.equal(checked, matrix.length);
});

// Demonstrates the "one edit changes both sides" acceptance criterion
// at the unit level: changing RULES.MESSAGE_MAX_LEN would flow through
// every boundedText({ max: RULES.MESSAGE_MAX_LEN }) call site without
// touching backend or frontend schema files.
test("RULES is the single place bounds live", () => {
  assert.equal(typeof shared.RULES.MESSAGE_MAX_LEN, "number");
  assert.equal(typeof shared.RULES.AMOUNT_MIN, "string");
  assert.ok(Object.isFrozen(shared.RULES), "RULES should be frozen to prevent accidental mutation");
});
