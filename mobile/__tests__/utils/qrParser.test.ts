/**
 * __tests__/utils/qrParser.test.ts
 *
 * Unit tests for the QR payload parser used by the Scan-to-Donate screen.
 *
 * Coverage:
 *   - stellar-indigopay://donate deep link (projectId, amount, memo)
 *   - legacy indigopay://donate deep link (wallet + project)
 *   - SEP-0007 web+stellar:pay URI (web WalletAddressQRCode format)
 *   - raw Stellar address
 *   - URL with an embedded Stellar address
 *   - invalid / unknown payloads
 *   - amount and memo sanitisation
 */
import { parseQRData } from "../../utils/qrParser";

const VALID_ADDRESS =
  "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("parseQRData", () => {
  describe("stellar-indigopay:// deep links", () => {
    it("parses projectId, amount, and memo", () => {
      const result = parseQRData(
        "stellar-indigopay://donate?projectId=proj-1&amount=50&memo=Conference",
      );
      expect(result).toEqual({
        type: "donate_link",
        projectId: "proj-1",
        address: undefined,
        amount: "50",
        memo: "Conference",
        raw: "stellar-indigopay://donate?projectId=proj-1&amount=50&memo=Conference",
      });
    });

    it("parses a deep link with only a projectId", () => {
      const result = parseQRData("stellar-indigopay://donate?projectId=abc");
      expect(result.type).toBe("donate_link");
      expect(result.projectId).toBe("abc");
      expect(result.amount).toBeUndefined();
      expect(result.memo).toBeUndefined();
    });

    it("drops non-numeric and non-positive amounts", () => {
      expect(
        parseQRData("stellar-indigopay://donate?projectId=x&amount=abc")
          .amount,
      ).toBeUndefined();
      expect(
        parseQRData("stellar-indigopay://donate?projectId=x&amount=-5").amount,
      ).toBeUndefined();
      expect(
        parseQRData("stellar-indigopay://donate?projectId=x&amount=0").amount,
      ).toBeUndefined();
      expect(
        parseQRData("stellar-indigopay://donate?projectId=x&amount=12.5")
          .amount,
      ).toBe("12.5");
    });

    it("trims memos to the 28-byte Stellar text-memo limit", () => {
      const longMemo = "m".repeat(60);
      const result = parseQRData(
        `stellar-indigopay://donate?projectId=x&memo=${longMemo}`,
      );
      expect(result.memo).toHaveLength(28);
    });

    it("is unknown when the deep link has neither projectId nor address", () => {
      const result = parseQRData("stellar-indigopay://donate?amount=50");
      expect(result.type).toBe("unknown");
    });
  });

  describe("legacy indigopay:// deep links", () => {
    it("parses wallet and project from the pre-#84 format", () => {
      const result = parseQRData(
        `indigopay://donate?wallet=${VALID_ADDRESS}&project=proj-2`,
      );
      expect(result.type).toBe("donate_link");
      expect(result.projectId).toBe("proj-2");
      expect(result.address).toBe(VALID_ADDRESS);
    });

    it("is unknown when the legacy wallet param is invalid", () => {
      const result = parseQRData("indigopay://donate?wallet=not-a-wallet");
      expect(result.type).toBe("unknown");
    });
  });

  describe("SEP-0007 pay URIs (web WalletAddressQRCode)", () => {
    it("parses destination, amount, and memo", () => {
      const result = parseQRData(
        `web+stellar:pay?destination=${VALID_ADDRESS}&amount=25&memo=IndigoPay%3AAcme&memo_type=MEMO_TEXT`,
      );
      expect(result.type).toBe("stellar_address");
      expect(result.address).toBe(VALID_ADDRESS);
      expect(result.amount).toBe("25");
      expect(result.memo).toBe("IndigoPay:Acme");
    });

    it("is unknown when the destination is not a valid address", () => {
      const result = parseQRData("web+stellar:pay?destination=nope");
      expect(result.type).toBe("unknown");
    });
  });

  describe("raw Stellar addresses", () => {
    it("parses a bare address", () => {
      const result = parseQRData(VALID_ADDRESS);
      expect(result).toEqual({
        type: "stellar_address",
        address: VALID_ADDRESS,
        raw: VALID_ADDRESS,
      });
    });

    it("tolerates surrounding whitespace", () => {
      const result = parseQRData(`  ${VALID_ADDRESS}\n`);
      expect(result.type).toBe("stellar_address");
      expect(result.address).toBe(VALID_ADDRESS);
    });
  });

  describe("URLs with an embedded address", () => {
    it("extracts the address from an arbitrary URL", () => {
      const result = parseQRData(
        `https://indigopay.example/projects?wallet=${VALID_ADDRESS}&utm=qr`,
      );
      expect(result.type).toBe("stellar_address");
      expect(result.address).toBe(VALID_ADDRESS);
    });
  });

  describe("invalid input", () => {
    it.each([
      ["random text", "hello world"],
      ["too-short address", "GABC123"],
      ["secret key (S...)", `S${"A".repeat(55)}`],
      ["empty string", ""],
      ["other URL", "https://example.com/nothing-here"],
    ])("returns unknown for %s", (_label, input) => {
      const result = parseQRData(input);
      expect(result.type).toBe("unknown");
      expect(result.raw).toBe(input);
    });
  });
});
