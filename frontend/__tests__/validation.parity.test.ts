/**
 * validation.parity.test.ts — Issue #90-follow-up acceptance criteria:
 * "Parity test matrix (hundreds of generated inputs) passes with zero
 * divergence" and "Backend and frontend suites both green with the
 * shared module."
 *
 * Mirrors `backend/src/validators/schemas.parity.test.js`: both files
 * run the exact same generated case list (from
 * `shared/validation.fixtures.js`) against their own environment's
 * real schema, built by the same `createDonationSchema()` factory.
 */
import {
  fullDonationSchema,
  walletAddressSchema,
  stellarTxHashSchema,
} from "@/lib/validation/schemas";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fixtures = require("@shared/validation.fixtures");

const { buildParityMatrix, VALID_ADDRESS, VALID_TX_HASH, ADDRESS_CASES, TX_HASH_CASES } =
  fixtures;

const BASE_DONATION = {
  projectId: "proj-1",
  donorAddress: VALID_ADDRESS,
  transactionHash: VALID_TX_HASH,
  amountXLM: "5",
  currency: "XLM",
  message: "hello",
};

function payloadFor(field: string, input: string) {
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

describe("fullDonationSchema parity matrix (frontend)", () => {
  const matrix = buildParityMatrix({ seed: 42, fuzzCount: 200 }) as Array<{
    field: string;
    input: string;
    expected: boolean;
  }>;

  test(`matrix has hundreds of cases (${matrix.length})`, () => {
    expect(matrix.length).toBeGreaterThan(200);
  });

  test.each(matrix.map((c) => [c.field, c.input, c.expected] as const))(
    "%s = %j → valid:%s",
    (field, input, expected) => {
      const result = fullDonationSchema.safeParse(payloadFor(field, input));
      expect(result.success).toBe(expected);
    },
  );
});

describe("standalone field validators (frontend)", () => {
  test("walletAddressSchema matches the ADDRESS_CASES oracle", () => {
    for (const [value, expected] of ADDRESS_CASES as Array<[string, boolean]>) {
      expect(walletAddressSchema.safeParse(value).success).toBe(expected);
    }
  });

  test("stellarTxHashSchema matches the TX_HASH_CASES oracle", () => {
    for (const [value, expected] of TX_HASH_CASES as Array<[string, boolean]>) {
      expect(stellarTxHashSchema.safeParse(value).success).toBe(expected);
    }
  });
});
