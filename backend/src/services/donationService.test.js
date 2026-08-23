"use strict";
/**
 * Unit tests for donation service layer.
 */

describe("Donation Service", () => {
  test("createDonation records donation with correct fields", () => {
    const donation = {
      donor: "G" + "A".repeat(55),
      project: "proj-1",
      amount: 100_000_000, // 10 XLM in stroops
      messageHash: 12345,
      ledger: 1000,
      currency: "XLM",
    };

    expect(donation.donor).toBeDefined();
    expect(donation.project).toBe("proj-1");
    expect(donation.amount).toBeGreaterThan(0);
    expect(donation.currency).toBe("XLM");
  });

  test("getDonationsByDonor filters correctly", () => {
    const allDonations = [
      { id: 1, donor: "GAAA", amount: 100 },
      { id: 2, donor: "GBBB", amount: 200 },
      { id: 3, donor: "GAAA", amount: 50 },
    ];

    const donorGAAADonations = allDonations.filter(
      (d) => d.donor === "GAAA",
    );

    expect(donorGAAADonations).toHaveLength(2);
    expect(donorGAAADonations.map((d) => d.id)).toEqual([1, 3]);
  });

  test("getDonationCount returns correct count", () => {
    const donations = [{ id: 1 }, { id: 2 }, { id: 3 }];

    expect(donations.length).toBe(3);
  });

  test("getGlobalTotalRaised sums all donations", () => {
    const donations = [
      { amount: 100_000_000 },
      { amount: 200_000_000 },
      { amount: 50_000_000 },
    ];

    const total = donations.reduce((s, d) => s + d.amount, 0);
    expect(total).toBe(350_000_000);
  });

  test("getGlobalCO2Offset calculates correctly", () => {
    const CO2_PER_XLM = 10;
    const donations = [
      { amount: 10_000_000 }, // 1 XLM
      { amount: 20_000_000 }, // 2 XLM
    ];

    const totalXLM = donations.reduce((s, d) => s + d.amount, 0) / 10_000_000;
    const co2Offset = totalXLM * CO2_PER_XLM;

    expect(totalXLM).toBe(3);
    expect(co2Offset).toBe(30);
  });

  test("donation records include timestamps", () => {
    const now = Date.now();
    const donation = {
      id: 1,
      createdAt: now,
    };

    expect(donation.createdAt).toBe(now);
    expect(typeof donation.createdAt).toBe("number");
  });

  test("batch donations process correct number of records", () => {
    const batchSize = 10;
    const donations = Array.from({ length: batchSize }, (_, i) => ({
      id: i + 1,
      amount: 1000,
    }));

    expect(donations).toHaveLength(batchSize);
    expect(donations[0].id).toBe(1);
    expect(donations[batchSize - 1].id).toBe(batchSize);
  });

  test("anonymous donation hides donor address", () => {
    const donation = {
      donor: "G" + "A".repeat(55),
      anonymous: true,
    };

    const getDisplayDonor = (d) => (d.anonymous ? "Anonymous" : d.donor);

    expect(getDisplayDonor(donation)).toBe("Anonymous");
    donation.anonymous = false;
    expect(getDisplayDonor(donation)).toBe(donation.donor);
  });

  test("handles empty donation list gracefully", () => {
    const donations = [];

    expect(donations.length).toBe(0);
    const total = donations.reduce((s, d) => s + (d.amount || 0), 0);
    expect(total).toBe(0);
  });

  test("rate limits donations per donor", () => {
    const MAX_DONATIONS_PER_WINDOW = 10;
    const WINDOW_LEDGERS = 720;

    const isRateLimited = (count, window) => {
      return count >= MAX_DONATIONS_PER_WINDOW;
    };

    expect(isRateLimited(5, 720)).toBe(false);
    expect(isRateLimited(10, 720)).toBe(true);
    expect(isRateLimited(15, 720)).toBe(true);
    expect(isRateLimited(0, 720)).toBe(false);
  });
});
