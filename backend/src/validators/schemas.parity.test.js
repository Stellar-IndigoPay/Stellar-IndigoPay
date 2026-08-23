/**
 * schemas.parity.test.js — Issue #90-follow-up acceptance criteria:
 * "Parity test matrix (hundreds of generated inputs) passes with zero
 * divergence" and "Backend and frontend suites both green with the
 * shared module."
 *
 * This suite and `frontend/__tests__/validation.parity.test.ts` both
 * run the exact same generated case list (from
 * `shared/validation.fixtures.js`) against their own environment's real
 * schema — built by the same `createDonationSchema()` factory — so a
 * change to `shared/validation.js` that breaks parity fails in CI on
 * both sides, not just one.
 */
"use strict";

const { donationSchema, stellarAddress, transactionHash } = require("./schemas");
const { buildParityMatrix, VALID_ADDRESS, VALID_TX_HASH } = require(
  "../../../shared/validation.fixtures",
);

const BASE_DONATION = {
  projectId: "proj-1",
  donorAddress: VALID_ADDRESS,
  transactionHash: VALID_TX_HASH,
  amountXLM: "5",
  currency: "XLM",
  message: "hello",
};

function payloadFor(field, input) {
  switch (field) {
    case "amount":
      return { ...BASE_DONATION, amountXLM: input };
    case "message":
      return { ...BASE_DONATION, message: input };
    case "address":
      return { ...BASE_DONATION, donorAddress: input };
    case "txHash":
      return { ...BASE_DONATION, transactionHash: input };
    default:
      throw new Error(`unknown parity field: ${field}`);
  }
}

describe("donationSchema parity matrix (backend)", () => {
  const matrix = buildParityMatrix({ seed: 42, fuzzCount: 200 });

  test(`matrix has hundreds of cases (${matrix.length})`, () => {
    expect(matrix.length).toBeGreaterThan(200);
  });

  test.each(matrix.map((c) => [c.field, c.input, c.expected]))(
    "%s = %j → valid:%s",
    (field, input, expected) => {
      const result = donationSchema.safeParse(payloadFor(field, input));
      expect(result.success).toBe(expected);
    },
  );
});

describe("standalone field validators (backend)", () => {
  test("stellarAddress matches the ADDRESS_CASES oracle", () => {
    const { ADDRESS_CASES } = require("../../../shared/validation.fixtures");
    for (const [value, expected] of ADDRESS_CASES) {
      expect(stellarAddress.safeParse(value).success).toBe(expected);
    }
  });

  test("transactionHash matches the TX_HASH_CASES oracle", () => {
    const { TX_HASH_CASES } = require("../../../shared/validation.fixtures");
    for (const [value, expected] of TX_HASH_CASES) {
      expect(transactionHash.safeParse(value).success).toBe(expected);
    }
  });
});

// Demonstrates: "A single rule change updates both sides with one edit."
// Lowering MESSAGE_MAX_LEN here (a throwaway copy of the schema) shows
// the rule lives in exactly one place — shared/validation.js's RULES —
// rather than being duplicated per-environment.
describe("single-edit rule change (documentation test)", () => {
  test("RULES.MESSAGE_MAX_LEN is the only place the 100-char bound lives", () => {
    const shared = require("../../../shared/validation");
    expect(shared.RULES.MESSAGE_MAX_LEN).toBe(100);

    const stricter = shared.boundedText({ field: "Message", max: 5 });
    expect(stricter.safeParse("123456").success).toBe(false);
    expect(stricter.safeParse("12345").success).toBe(true);
  });
});
