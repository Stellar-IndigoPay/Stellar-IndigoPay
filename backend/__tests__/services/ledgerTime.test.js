/**
 * __tests__/services/ledgerTime.test.js
 *
 * Tests for converting Stellar ledger counts into wall-clock milliseconds.
 */
"use strict";

const { ledgerToMs } = require("../../src/lib/ledgerTime");

describe("ledgerToMs", () => {
  test("converts ledger counts using the default 5s ledger cadence", () => {
    expect(ledgerToMs(1)).toBe(5000);
    expect(ledgerToMs(12)).toBe(60000);
    expect(ledgerToMs(60)).toBe(300000);
  });

  test("supports network-specific overrides", () => {
    expect(ledgerToMs(10, "testnet")).toBe(50000);
    expect(ledgerToMs(10, "mainnet")).toBe(50000);
  });

  test("returns zero for invalid/negative ledger counts", () => {
    expect(ledgerToMs(-3)).toBe(0);
    expect(ledgerToMs(Number.NaN)).toBe(0);
    expect(ledgerToMs(undefined)).toBe(0);
  });
});
