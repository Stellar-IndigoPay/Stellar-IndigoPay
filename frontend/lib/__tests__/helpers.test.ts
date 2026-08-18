/**
 * Unit tests for utility/helper functions.
 */

import { describe, test, expect } from "@jest/globals";

describe("Utility helpers", () => {
  describe("CO2 offset calculation", () => {
    test("calculates CO2 offset from XLM amount", () => {
      const calculateCO2 = (amountStroops: number, co2PerXlm: number): number => {
        const xlmAmount = amountStroops / 10_000_000;
        return Math.floor(xlmAmount * co2PerXlm);
      };

      // 1 XLM = 10_000_000 stroops, CO2 rate = 10 g/XLM
      expect(calculateCO2(10_000_000, 10)).toBe(10);
      expect(calculateCO2(50_000_000, 10)).toBe(50);
      expect(calculateCO2(100_000, 10)).toBe(0);
    });

    test("handles zero CO2 rate", () => {
      const calculateCO2 = (amountStroops: number, co2PerXlm: number): number => {
        const xlmAmount = amountStroops / 10_000_000;
        return Math.floor(xlmAmount * co2PerXlm);
      };

      expect(calculateCO2(10_000_000, 0)).toBe(0);
    });
  });

  describe("Amount formatting", () => {
    test("formats stroops to XLM string", () => {
      const formatXLM = (stroops: number): string => {
        return (stroops / 10_000_000).toFixed(4);
      };

      expect(formatXLM(10_000_000)).toBe("1.0000");
      expect(formatXLM(1_000_000)).toBe("0.1000");
      expect(formatXLM(0)).toBe("0.0000");
    });

    test("formats large XLM amounts", () => {
      const formatXLM = (stroops: number): string => {
        return (stroops / 10_000_000).toFixed(2);
      };

      expect(formatXLM(100_000_000_000)).toBe("10000.00");
      expect(formatXLM(1_234_567_890)).toBe("123.46");
    });
  });

  describe("Badge tier calculation", () => {
    const computeBadgeTier = (totalDonated: number): string => {
      if (totalDonated >= 2000 * 10_000_000) return "EarthGuardian";
      if (totalDonated >= 500 * 10_000_000) return "Forest";
      if (totalDonated >= 100 * 10_000_000) return "Tree";
      if (totalDonated >= 10 * 10_000_000) return "Seedling";
      return "None";
    };

    test("returns None for 0 donations", () => {
      expect(computeBadgeTier(0)).toBe("None");
    });

    test("returns Seedling at 10 XLM", () => {
      expect(computeBadgeTier(10 * 10_000_000)).toBe("Seedling");
    });

    test("returns Tree at 100 XLM", () => {
      expect(computeBadgeTier(100 * 10_000_000)).toBe("Tree");
    });

    test("returns Forest at 500 XLM", () => {
      expect(computeBadgeTier(500 * 10_000_000)).toBe("Forest");
    });

    test("returns EarthGuardian at 2000 XLM", () => {
      expect(computeBadgeTier(2000 * 10_000_000)).toBe("EarthGuardian");
    });

    test("transitions correctly at boundaries", () => {
      expect(computeBadgeTier(9 * 10_000_000 + 9_999_999)).toBe("None");
      expect(computeBadgeTier(10 * 10_000_000)).toBe("Seedling");
      expect(computeBadgeTier(99 * 10_000_000 + 9_999_999)).toBe("Seedling");
      expect(computeBadgeTier(100 * 10_000_000)).toBe("Tree");
    });
  });

  describe("Date/time helpers", () => {
    test("converts ledgers to days", () => {
      const ledgersToDays = (ledgers: number): number => {
        const seconds = ledgers * 5; // 5 seconds per ledger
        return Math.round(seconds / 86400);
      };

      expect(ledgersToDays(17280)).toBe(1); // 1 day
      expect(ledgersToDays(120960)).toBe(7); // 7 days
      expect(ledgersToDays(518400)).toBe(30); // 30 days
    });

    test("converts days to ledgers", () => {
      const daysToLedgers = (days: number): number => {
        const seconds = days * 86400;
        return Math.round(seconds / 5);
      };

      expect(daysToLedgers(1)).toBe(17280);
      expect(daysToLedgers(7)).toBe(120960);
    });
  });

  describe("Milestone percentage validation", () => {
    type Milestone = { percentage: number };

    test("validates milestone percentages sum to 100", () => {
      const validateMilestones = (milestones: Milestone[]): boolean => {
        const sum = milestones.reduce((s: number, m: Milestone) => s + m.percentage, 0);
        if (sum !== 100) return false;
        if (milestones.some((m: Milestone) => m.percentage < 0 || m.percentage > 100))
          return false;
        return true;
      };

      expect(
        validateMilestones([{ percentage: 50 }, { percentage: 30 }, { percentage: 20 }]),
      ).toBe(true);

      expect(validateMilestones([{ percentage: 100 }])).toBe(true);

      expect(validateMilestones([{ percentage: 50 }, { percentage: 40 }])).toBe(
        false,
      );

      expect(validateMilestones([])).toBe(false);
    });
  });

  describe("Address truncation", () => {
    type TruncateFn = (addr: string | null) => string;

    test("truncates Stellar address for display", () => {
      const truncateAddress: TruncateFn = (addr) => {
        if (!addr || addr.length < 12) return addr || "";
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      };

      const addr = "G" + "A".repeat(55);
      expect(truncateAddress(addr)).toBe("GAAAAA...AAAA");
    });

    test("returns short addresses unchanged", () => {
      const truncateAddress: TruncateFn = (addr) => {
        if (!addr || addr.length < 12) return addr || "";
        return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
      };

      expect(truncateAddress("short")).toBe("short");
      expect(truncateAddress("")).toBe("");
      expect(truncateAddress(null)).toBe("");
    });
  });
});
