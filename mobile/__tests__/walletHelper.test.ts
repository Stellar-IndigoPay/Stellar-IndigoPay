/**
 * Unit tests for wallet helper utilities.
 */

describe("Wallet helpers", () => {
  describe("Balance formatting", () => {
    test("formats stroops to XLM with 4 decimal places", () => {
      const formatXLM = (stroops: number) => (stroops / 10_000_000).toFixed(4);

      expect(formatXLM(10_000_000)).toBe("1.0000");
      expect(formatXLM(5_000_000)).toBe("0.5000");
      expect(formatXLM(0)).toBe("0.0000");
      expect(formatXLM(1)).toBe("0.0000");
    });

    test("formats large balances", () => {
      const formatXLM = (stroops: number) =>
        (stroops / 10_000_000).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });

      expect(formatXLM(100_000_000_000)).toBe("10,000.00");
    });
  });

  describe("Address validation", () => {
    test("validates Stellar address format", () => {
      const isValidStellarAddress = (addr: string) => {
        return /^G[A-Z2-7]{55}$/.test(addr);
      };

      // Valid format
      expect(
        isValidStellarAddress(
          "G" + "0".repeat(55),
        ),
      ).toBe(false); // '0' is not in the Stellar base32 alphabet (A-Z,2-7)
      expect(isValidStellarAddress("")).toBe(false);
      expect(isValidStellarAddress("not-an-address")).toBe(false);
    });

    test("validates address length", () => {
      const validLength = (addr: string) => addr.length === 56;

      expect(validLength("G" + "X".repeat(55))).toBe(true);
      expect(validLength("short")).toBe(false);
      expect(validLength("")).toBe(false);
    });
  });

  describe("Transaction fee estimation", () => {
    test("estimates minimum transaction fee", () => {
      const BASE_FEE = 100; // stroops
      const estimateFee = (operations: number) => BASE_FEE * operations;

      expect(estimateFee(1)).toBe(100);
      expect(estimateFee(3)).toBe(300);
      expect(estimateFee(10)).toBe(1000);
    });

    test("estimates fee with safety margin", () => {
      const BASE_FEE = 100;
      const SAFETY_MARGIN = 1.5;
      const estimateFeeWithMargin = (operations: number) =>
        Math.ceil(BASE_FEE * operations * SAFETY_MARGIN);

      expect(estimateFeeWithMargin(1)).toBe(150);
      expect(estimateFeeWithMargin(2)).toBe(300);
    });
  });

  describe("Amount conversion", () => {
    test("converts XLM to stroops", () => {
      const xlmToStroops = (xlm: number) => Math.round(xlm * 10_000_000);

      expect(xlmToStroops(1)).toBe(10_000_000);
      expect(xlmToStroops(0.5)).toBe(5_000_000);
      expect(xlmToStroops(0)).toBe(0);
    });

    test("converts stroops to XLM", () => {
      const stroopsToXLM = (stroops: number) => stroops / 10_000_000;

      expect(stroopsToXLM(10_000_000)).toBe(1);
      expect(stroopsToXLM(50_000_000)).toBe(5);
    });
  });

  describe("Donation summary calculation", () => {
    test("calculates total donations", () => {
      const donations = [
        { amount: 100 * 10_000_000 },
        { amount: 50 * 10_000_000 },
        { amount: 25 * 10_000_000 },
      ];

      const total = donations.reduce((s, d) => s + d.amount, 0);
      expect(total).toBe(175 * 10_000_000);
    });

    test("calculates CO2 offset", () => {
      const CO2_PER_XLM = 10; // grams per XLM
      const totalStroops = 100 * 10_000_000;

      const co2Offset = (totalStroops / 10_000_000) * CO2_PER_XLM;
      expect(co2Offset).toBe(1000); // 100 XLM * 10 g/XLM
    });
  });
});
