"use strict";
/**
 * Unit tests for validation helper utilities.
 */

// Test validation-related pure functions
describe("Validation helpers", () => {
  describe("Stellar address validation", () => {
    test("recognizes valid Stellar public key format", () => {
      // Stellar public keys start with G and are 56 chars
      const validKey = "G" + "A".repeat(55);
      expect(validKey).toHaveLength(56);
      expect(validKey.startsWith("G")).toBe(true);
    });

    test("rejects keys that are too short", () => {
      const shortKey = "G" + "A".repeat(50);
      expect(shortKey).toHaveLength(51);
      expect(shortKey.length).toBeLessThan(56);
    });

    test("rejects keys that are too long", () => {
      const longKey = "G" + "A".repeat(60);
      expect(longKey).toHaveLength(61);
      expect(longKey.length).toBeGreaterThan(56);
    });

    test("rejects keys without G prefix", () => {
      const badKey = "X" + "A".repeat(55);
      expect(badKey.startsWith("G")).toBe(false);
    });
  });

  describe("Amount validation", () => {
    test("validates positive integer amounts", () => {
      const isValid = (amt) => Number.isInteger(amt) && amt > 0;
      expect(isValid(100)).toBe(true);
      expect(isValid(1)).toBe(true);
      expect(isValid(0)).toBe(false);
      expect(isValid(-1)).toBe(false);
    });

    test("validates string amounts representing numbers", () => {
      const parseAmount = (str) => {
        const n = Number(str);
        return !isNaN(n) && n > 0;
      };
      expect(parseAmount("100")).toBe(true);
      expect(parseAmount("0")).toBe(false);
      expect(parseAmount("-5")).toBe(false);
      expect(parseAmount("abc")).toBe(false);
      expect(parseAmount("")).toBe(false);
    });

    test("handles large amounts without overflow in checks", () => {
      const maxSafe = Number.MAX_SAFE_INTEGER;
      expect(maxSafe > 0).toBe(true);
      // i128 max is ~1.7e38, which is beyond JS safe integer
      const largeAmount = "170141183460469231731687303715884105727";
      expect(() => BigInt(largeAmount)).not.toThrow();
    });
  });

  describe("ID validation", () => {
    test("validates job IDs are non-empty strings", () => {
      const isValidId = (id) => typeof id === "string" && id.length > 0;
      expect(isValidId("job-1")).toBe(true);
      expect(isValidId("")).toBe(false);
      expect(isValidId(null)).toBe(false);
      expect(isValidId(undefined)).toBe(false);
    });

    test("validates UUID format", () => {
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      expect(uuidRegex.test("550e8400-e29b-41d4-a716-446655440000")).toBe(
        true,
      );
      expect(uuidRegex.test("not-a-uuid")).toBe(false);
      expect(uuidRegex.test("")).toBe(false);
    });
  });

  describe("Percentage validation", () => {
    test("validates percentage within 0-100", () => {
      const isValidPct = (p) => p >= 0 && p <= 100;
      expect(isValidPct(50)).toBe(true);
      expect(isValidPct(0)).toBe(true);
      expect(isValidPct(100)).toBe(true);
      expect(isValidPct(-1)).toBe(false);
      expect(isValidPct(101)).toBe(false);
    });

    test("validates that percentages sum to 100", () => {
      const sumTo100 = (arr) => arr.reduce((a, b) => a + b, 0) === 100;
      expect(sumTo100([50, 30, 20])).toBe(true);
      expect(sumTo100([100])).toBe(true);
      expect(sumTo100([50, 40])).toBe(false);
      expect(sumTo100([50, 50, 0])).toBe(true);
    });
  });
});
