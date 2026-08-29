jest.mock("@stellar/stellar-sdk", () => {
  const sdk = jest.requireActual(
    "../../node_modules/@stellar/stellar-sdk/lib/cjs/base/strkey.js",
  ) as {
    StrKey: {
      isValidEd25519PublicKey(publicKey: string): boolean;
    };
  };
  return { StrKey: sdk.StrKey };
});

import {
  isValidStellarDestination,
  submitDonationRequest,
  validateDonationRequest,
  validateQuickDonateState,
} from "../lib/donation";

const VALID_DESTINATION =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

beforeEach(() => {
  jest.clearAllMocks();
  (globalThis as any).chrome.runtime.lastError = null;
});

describe("donation validation", () => {
  test("accepts a valid Stellar destination and amount", () => {
    expect(isValidStellarDestination(VALID_DESTINATION)).toBe(true);
    expect(validateDonationRequest(VALID_DESTINATION, 5, "Thanks")).toBeNull();
  });

  test("validates the Stellar destination checksum and trims whitespace", () => {
    const checksumInvalidDestination =
      VALID_DESTINATION.slice(0, -1) +
      (VALID_DESTINATION.endsWith("A") ? "B" : "A");

    expect(isValidStellarDestination(`  ${VALID_DESTINATION}  `)).toBe(true);
    expect(isValidStellarDestination(checksumInvalidDestination)).toBe(false);
    expect(isValidStellarDestination("Gnot-a-valid-address")).toBe(false);
  });

  test("rejects missing/invalid required state", () => {
    expect(validateDonationRequest("", 5)).toBe("Invalid destination address");
    expect(validateDonationRequest(VALID_DESTINATION, 0.05)).toBe(
      "Minimum donation is 0.1 XLM",
    );
  });

  test("accepts an empty memo and a 28-byte ASCII memo", () => {
    expect(validateDonationRequest(VALID_DESTINATION, 5, "")).toBeNull();
    expect(validateDonationRequest(VALID_DESTINATION, 5, "A".repeat(28))).toBeNull();
  });

  test("rejects memos over the 28-byte UTF-8 limit", () => {
    expect(validateDonationRequest(VALID_DESTINATION, 5, "A".repeat(29))).toBe(
      "Memo must be 28 bytes or fewer",
    );
    expect(validateDonationRequest(VALID_DESTINATION, 5, "🙂".repeat(8))).toBe(
      "Memo must be 28 bytes or fewer",
    );
  });

  test("rejects a non-string memo", () => {
    expect(validateDonationRequest(VALID_DESTINATION, 5, 123)).toBe(
      "Memo must be 28 bytes or fewer",
    );
  });
});

describe("Quick Donate state validation", () => {
  test("requires a ready wallet, destination, and valid amount", () => {
    expect(validateQuickDonateState(null, VALID_DESTINATION, 5)).toBe(
      "Connect your wallet before donating.",
    );
    expect(validateQuickDonateState(VALID_DESTINATION, "", 5)).toBe(
      "Invalid destination address",
    );
    expect(validateQuickDonateState(VALID_DESTINATION, VALID_DESTINATION, 0.05)).toBe(
      "Minimum donation is 0.1 XLM",
    );
    expect(validateQuickDonateState(VALID_DESTINATION, VALID_DESTINATION, 5)).toBeNull();
  });
});

describe("submitDonationRequest", () => {
  test("uses the canonical SUBMIT_DONATION message", async () => {
    (chrome.runtime.sendMessage as jest.Mock).mockImplementation(
      (_message: unknown, callback: (response: { success: boolean }) => void) => {
        callback({ success: true });
      },
    );

    await expect(submitDonationRequest(VALID_DESTINATION, 5, "Thanks")).resolves.toBeUndefined();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
      {
        type: "SUBMIT_DONATION",
        address: VALID_DESTINATION,
        amount: 5,
        memo: "Thanks",
      },
      expect.any(Function),
    );
  });

  test("does not send when required validation fails", async () => {
    await expect(submitDonationRequest("bad", 5)).rejects.toThrow(
      "Invalid destination address",
    );
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
