/**
 * Tests for coverage-helpers.ts — pure utility functions.
 */
import {
  stroopsToXLM,
  xlmToStroops,
  isValidStellarAddress,
  hasValidAddressLength,
  estimateFee,
  estimateFeeWithMargin,
  calculateCO2Offset,
} from "../utils/coverage-helpers";

describe("stroopsToXLM", () => {
  test("converts 10_000_000 stroops to 1.0000 XLM", () => {
    expect(stroopsToXLM(10_000_000)).toBe("1.0000");
  });

  test("converts 5_000_000 stroops to 0.5000 XLM", () => {
    expect(stroopsToXLM(5_000_000)).toBe("0.5000");
  });

  test("converts 0 stroops to 0.0000 XLM", () => {
    expect(stroopsToXLM(0)).toBe("0.0000");
  });

  test("converts 1 stroop to 0.0000 XLM", () => {
    expect(stroopsToXLM(1)).toBe("0.0000");
  });
});

describe("xlmToStroops", () => {
  test("converts 1 XLM to 10_000_000 stroops", () => {
    expect(xlmToStroops(1)).toBe(10_000_000);
  });

  test("converts 0.5 XLM to 5_000_000 stroops", () => {
    expect(xlmToStroops(0.5)).toBe(5_000_000);
  });

  test("converts 0 XLM to 0 stroops", () => {
    expect(xlmToStroops(0)).toBe(0);
  });
});

describe("isValidStellarAddress", () => {
  test("validates correct Stellar address", () => {
    expect(
      isValidStellarAddress("GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG"),
    ).toBe(true);
  });

  test("rejects empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  test("rejects non-address text", () => {
    expect(isValidStellarAddress("not-an-address")).toBe(false);
  });

  test("rejects lowercase Stellar address", () => {
    expect(
      isValidStellarAddress("gdfjegwqoeplirvhkvngcfqbzqnbdwuyosrylkkbopfebfhiyndmkkhg"),
    ).toBe(false);
  });
});

describe("hasValidAddressLength", () => {
  test("returns true for 56 character address", () => {
    expect(hasValidAddressLength("G" + "X".repeat(55))).toBe(true);
  });

  test("returns false for empty string", () => {
    expect(hasValidAddressLength("")).toBe(false);
  });

  test("returns false for short string", () => {
    expect(hasValidAddressLength("short")).toBe(false);
  });
});

describe("estimateFee", () => {
  test("estimates fee for 1 operation", () => {
    expect(estimateFee(1)).toBe(100);
  });

  test("estimates fee for 3 operations", () => {
    expect(estimateFee(3)).toBe(300);
  });

  test("estimates fee for 10 operations", () => {
    expect(estimateFee(10)).toBe(1000);
  });

  test("uses custom base fee", () => {
    expect(estimateFee(2, 150)).toBe(300);
  });
});

describe("estimateFeeWithMargin", () => {
  test("estimates with margin for 1 operation", () => {
    expect(estimateFeeWithMargin(1)).toBe(150);
  });

  test("estimates with margin for 2 operations", () => {
    expect(estimateFeeWithMargin(2)).toBe(300);
  });

  test("uses custom base fee and margin", () => {
    expect(estimateFeeWithMargin(1, 200, 2)).toBe(400);
  });
});

describe("calculateCO2Offset", () => {
  test("calculates offset for 100 XLM", () => {
    expect(calculateCO2Offset(100)).toBe(1000);
  });

  test("calculates offset for 0 XLM", () => {
    expect(calculateCO2Offset(0)).toBe(0);
  });

  test("calculates offset with custom rate", () => {
    expect(calculateCO2Offset(10, 5)).toBe(50);
  });

  test("handles fractional XLM", () => {
    expect(calculateCO2Offset(0.5)).toBe(5);
  });
});
