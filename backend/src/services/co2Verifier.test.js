"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

// Mock fetch for external API calls
global.fetch = jest.fn();

// Mock prom-client
jest.mock("prom-client", () => ({
  Registry: jest.fn(() => ({ setDefaultLabels: jest.fn() })),
  Counter: jest.fn(() => ({ inc: jest.fn() })),
  Gauge: jest.fn(() => ({ set: jest.fn() })),
  Histogram: jest.fn(() => ({ observe: jest.fn() })),
  collectDefaultMetrics: jest.fn(),
}));

// Mock pg-boss
jest.mock("pg-boss", () => {
  return jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    start: jest.fn().mockResolvedValue(undefined),
    schedule: jest.fn().mockResolvedValue(undefined),
    work: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
  }));
});

const pool = require("../db/pool");
const {
  CATEGORY_BENCHMARKS,
  IPCC_TIER1_FACTORS,
  verifyCO2Rate,
  applyCO2VerificationToProject,
  fetchReferenceRates,
  fetchSatelliteEstimate,
  computeConfidenceBand,
  computeSeverity,
  computeDeviationPercent,
  verifyProjectCO2Rate,
  runVerificationForAllProjects,
  startCO2VerificationCron,
  stopCO2VerificationCron,
} = require("./co2Verifier");

// ═══════════════════════════════════════════════════════════════════════════
// 1. Original verifyCO2Rate tests (backward compatibility)
// ═══════════════════════════════════════════════════════════════════════════

describe("verifyCO2Rate", () => {
  test("rate within typical range is verified", () => {
    const result = verifyCO2Rate("Reforestation", 2.0);
    expect(result.status).toBe("verified");
    expect(result.reason).toBeNull();
    expect(result.multiplier).toBeCloseTo(0.8);
    expect(result.benchmark.category).toBe("Reforestation");
  });

  test("rate at exactly 3× the benchmark is still verified", () => {
    const result = verifyCO2Rate("Reforestation", 7.5);
    expect(result.status).toBe("verified");
  });

  test("rate 5× the benchmark is marked for review", () => {
    const result = verifyCO2Rate("Solar Energy", 15);
    expect(result.status).toBe("review");
    expect(result.multiplier).toBeCloseTo(5);
    expect(result.reason).toMatch(/Solar Energy/);
  });

  test("rate 15× the benchmark is flagged", () => {
    const result = verifyCO2Rate("Solar Energy", 45);
    expect(result.status).toBe("flagged");
    expect(result.multiplier).toBeCloseTo(15);
    expect(result.reason).toMatch(/15\.0×/);
  });

  test("grossly implausible rate (issue example) is flagged", () => {
    const result = verifyCO2Rate("Reforestation", 50000);
    expect(result.status).toBe("flagged");
    expect(result.multiplier).toBeCloseTo(20000);
  });

  test("unknown category falls back to the 'Other' benchmark", () => {
    const result = verifyCO2Rate("Quantum Composting", 30);
    expect(result.status).toBe("flagged");
    expect(result.benchmark.category).toBe("Other");
    expect(result.benchmark.co2PerXlmTypical).toBe(
      CATEGORY_BENCHMARKS.Other.co2_per_xlm_typical,
    );
  });

  test("accepts numeric strings (NUMERIC columns come back as strings)", () => {
    const result = verifyCO2Rate("Solar Energy", "0.0500000");
    expect(result.status).toBe("verified");
  });

  test("zero rate is verified (claims no offset at all)", () => {
    const result = verifyCO2Rate("Clean Water", 0);
    expect(result.status).toBe("verified");
    expect(result.multiplier).toBe(0);
  });

  test("unparseable rate fails closed as flagged", () => {
    const result = verifyCO2Rate("Reforestation", "not-a-number");
    expect(result.status).toBe("flagged");
    expect(result.multiplier).toBeNull();
    expect(result.reason).toMatch(/not a valid/);
  });

  test("negative rate fails closed as flagged", () => {
    const result = verifyCO2Rate("Reforestation", -5);
    expect(result.status).toBe("flagged");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. applyCO2VerificationToProject tests
// ═══════════════════════════════════════════════════════════════════════════

describe("applyCO2VerificationToProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const BASE_PARAMS = {
    walletAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    projectName: "Acme Solar Farm Phase 1",
    category: "Solar Energy",
    requestId: "11111111-1111-1111-1111-111111111111",
  };

  test("stamps the verdict onto the matching project row", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "project-1" }] });

    const result = await applyCO2VerificationToProject({
      ...BASE_PARAMS,
      co2PerXLM: "45",
    });

    expect(result.status).toBe("flagged");
    expect(result.projectIds).toEqual(["project-1"]);

    expect(pool.query).toHaveBeenCalledTimes(1);
    const [sql, values] = pool.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE projects/);
    expect(sql).toMatch(/co2_verification_status = \$1/);
    expect(values[0]).toBe("flagged");
    expect(values[2]).toBe(BASE_PARAMS.walletAddress);
    expect(values[3]).toBe(BASE_PARAMS.projectName);
  });

  test("returns the verdict even when no project row matches yet", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await applyCO2VerificationToProject({
      ...BASE_PARAMS,
      co2PerXLM: "0.05",
    });

    expect(result.status).toBe("verified");
    expect(result.projectIds).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. External API — fetchReferenceRates
// ═══════════════════════════════════════════════════════════════════════════

describe("fetchReferenceRates", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CO2_VERIFIER_GS_API_URL;
    delete process.env.CO2_VERIFIER_VERRA_API_URL;
  });

  test("falls back to static benchmarks when no external APIs configured", async () => {
    const result = await fetchReferenceRates("Reforestation", "Brazil");

    expect(result.source).toBe(
      "IndigoPay Category Benchmarks (IPCC-informed)",
    );
    expect(result.co2PerXlmTypical).toBe(2.5);
    expect(result.maxReasonable).toBe(25);
    expect(result.category).toBe("Reforestation");
  });

  test("falls back to Other category for unknown categories", async () => {
    const result = await fetchReferenceRates(
      "Unknown Category",
      "Somewhere",
    );

    expect(result.category).toBe("Other");
    expect(result.co2PerXlmTypical).toBe(2.0);
  });

  test("uses Gold Standard API when configured and available", async () => {
    process.env.CO2_VERIFIER_GS_API_URL = "https://gs-api.example.com/rates";

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        co2_per_xlm_typical: 4.2,
        max_reasonable: 42,
      }),
    });

    const result = await fetchReferenceRates("Carbon Capture", "Norway");

    expect(result.source).toBe("Gold Standard Impact Registry");
    expect(result.co2PerXlmTypical).toBe(4.2);
    expect(result.maxReasonable).toBe(42);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test("falls through to next source when Gold Standard API fails", async () => {
    process.env.CO2_VERIFIER_GS_API_URL = "https://gs-api.example.com/rates";

    fetch.mockRejectedValueOnce(new Error("Network error"));

    const result = await fetchReferenceRates("Wind Energy", "Denmark");

    // Should fall back to static benchmarks
    expect(result.source).toBe(
      "IndigoPay Category Benchmarks (IPCC-informed)",
    );
    expect(result.co2PerXlmTypical).toBe(3.5);
  });

  test("falls through when Gold Standard returns non-ok status", async () => {
    process.env.CO2_VERIFIER_GS_API_URL = "https://gs-api.example.com/rates";

    fetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
    });

    const result = await fetchReferenceRates("Solar Energy", "India");

    expect(result.source).toBe(
      "IndigoPay Category Benchmarks (IPCC-informed)",
    );
  });

  test("falls through when Gold Standard returns unexpected shape", async () => {
    process.env.CO2_VERIFIER_GS_API_URL = "https://gs-api.example.com/rates";

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ message: "Hello" }), // missing co2_per_xlm_typical
    });

    const result = await fetchReferenceRates("Clean Water", "Kenya");

    expect(result.source).toBe(
      "IndigoPay Category Benchmarks (IPCC-informed)",
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Satellite data — fetchSatelliteEstimate
// ═══════════════════════════════════════════════════════════════════════════

describe("fetchSatelliteEstimate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CO2_VERIFIER_GFW_API_URL;
    delete process.env.CO2_VERIFIER_GFW_API_KEY;
  });

  test("returns null for non-reforestation categories", async () => {
    const result = await fetchSatelliteEstimate("Solar Energy", "Germany");
    expect(result).toBeNull();
  });

  test("returns IPCC tier-1 estimate when no GFW API configured", async () => {
    const result = await fetchSatelliteEstimate(
      "Reforestation",
      "-3.0, -60.0",
    );

    expect(result).not.toBeNull();
    expect(result.tco2PerHaPerYear).toBeGreaterThan(0);
    expect(result.source).toMatch(/IPCC Tier-1/);
  });

  test("uses tropical IPCC factor for near-equator locations", async () => {
    const result = await fetchSatelliteEstimate(
      "Reforestation",
      "10.0, -75.0", // Colombia — tropical
    );

    expect(result.tco2PerHaPerYear).toBe(
      IPCC_TIER1_FACTORS.reforestation_tropical.tco2_per_ha_yr,
    );
  });

  test("uses temperate IPCC factor for mid-latitude locations", async () => {
    const result = await fetchSatelliteEstimate(
      "Reforestation",
      "45.0, -120.0", // Oregon — temperate
    );

    expect(result.tco2PerHaPerYear).toBe(
      IPCC_TIER1_FACTORS.reforestation_temperate.tco2_per_ha_yr,
    );
  });

  test("uses boreal IPCC factor for high-latitude locations", async () => {
    const result = await fetchSatelliteEstimate(
      "Reforestation",
      "65.0, 25.0", // Finland — boreal
    );

    expect(result.tco2PerHaPerYear).toBe(
      IPCC_TIER1_FACTORS.reforestation_boreal.tco2_per_ha_yr,
    );
  });

  test("uses default IPCC factor when location has no coordinates", async () => {
    const result = await fetchSatelliteEstimate(
      "Reforestation",
      "Amazon Basin, Brazil", // no explicit coordinates
    );

    expect(result.tco2PerHaPerYear).toBe(
      IPCC_TIER1_FACTORS.reforestation_default.tco2_per_ha_yr,
    );
  });

  test("uses GFW API when configured and available", async () => {
    process.env.CO2_VERIFIER_GFW_API_URL = "https://gfw-api.example.com";
    process.env.CO2_VERIFIER_GFW_API_KEY = "test-key";

    fetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ tco2_per_ha_per_year: 8.5 }),
    });

    const result = await fetchSatelliteEstimate(
      "Reforestation",
      "-15.0, -50.0",
    );

    expect(result.tco2PerHaPerYear).toBe(8.5);
    expect(result.source).toMatch(/Global Forest Watch/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Confidence band calculation
// ═══════════════════════════════════════════════════════════════════════════

describe("computeConfidenceBand", () => {
  test("produces reasonable band from reference rates alone", () => {
    const refRates = {
      co2PerXlmTypical: 2.5, // kg → 2500 g
      maxReasonable: 25,     // kg → 25000 g
      source: "Test",
      category: "Reforestation",
    };

    const band = computeConfidenceBand(refRates, null);

    // lower = 2500 * 0.5 = 1250
    // upper = 25000
    expect(band.lower).toBe(1250);
    expect(band.upper).toBe(25000);
  });

  test("tightens upper bound with satellite data for reforestation", () => {
    const refRates = {
      co2PerXlmTypical: 2.5,
      maxReasonable: 25,
      source: "Test",
      category: "Reforestation",
    };
    const satellite = { tco2PerHaPerYear: 8.0, source: "GFW" };

    const band = computeConfidenceBand(refRates, satellite);

    // satelliteUpper = 8.0 * 1000 * 2 = 16000
    // upper = min(25000, 16000) = 16000
    expect(band.upper).toBe(16000);
    // lower tightened by satellite: max(1250, 8.0 * 100) = max(1250, 800) = 1250
    expect(band.lower).toBe(1250);
  });

  test("satellite estimate does not inflate upper bound above benchmark", () => {
    const refRates = {
      co2PerXlmTypical: 1.0,
      maxReasonable: 10,
      source: "Test",
      category: "Clean Water",
    };
    // Satellite says 20 tCO2/ha/yr — this would give 40000 g/XLM upper,
    // but the benchmark caps it at 10000
    const satellite = { tco2PerHaPerYear: 20.0, source: "NASA" };

    const band = computeConfidenceBand(refRates, satellite);

    // satelliteUpper = 20 * 1000 * 2 = 40000
    // upper = min(10000, 40000) = 10000
    expect(band.upper).toBe(10000);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Severity and deviation
// ═══════════════════════════════════════════════════════════════════════════

describe("computeSeverity", () => {
  test("rate within 1.5× upper bound = none", () => {
    expect(computeSeverity(1000, 1000)).toBe("none");
    expect(computeSeverity(1500, 1000)).toBe("none"); // exactly 1.5×
  });

  test("rate between 1.5× and 3× upper bound = warning", () => {
    expect(computeSeverity(1501, 1000)).toBe("warning");
    expect(computeSeverity(3000, 1000)).toBe("warning"); // exactly 3×
  });

  test("rate above 3× upper bound = critical", () => {
    expect(computeSeverity(3001, 1000)).toBe("critical");
    expect(computeSeverity(50000, 1000)).toBe("critical");
  });
});

describe("computeDeviationPercent", () => {
  test("returns 0 when rate is within bounds", () => {
    expect(computeDeviationPercent(500, 1000)).toBe(0);
  });

  test("returns percentage above upper bound", () => {
    expect(computeDeviationPercent(2000, 1000)).toBe(100); // 100% above
    expect(computeDeviationPercent(3000, 1000)).toBe(200); // 200% above
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Full pipeline — verifyProjectCO2Rate
// ═══════════════════════════════════════════════════════════════════════════

describe("verifyProjectCO2Rate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CO2_VERIFIER_GS_API_URL;
    delete process.env.CO2_VERIFIER_GFW_API_URL;
  });

  const MOCK_PROJECT = {
    id: "proj-001",
    name: "Amazon Reforestation",
    category: "Reforestation",
    location: "-3.0, -60.0",
    wallet_address: "GABC123",
    co2_offset_kg: 2, // 2000 g/XLM — should be plausible for reforestation
  };

  test("produces plausible result for reasonable rate", async () => {
    // Mock: project lookup returns co2_offset_kg
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 2 }] });
    // Mock: insert verification run
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await verifyProjectCO2Rate(MOCK_PROJECT);

    expect(result.projectId).toBe("proj-001");
    expect(result.isPlausible).toBe(true);
    expect(result.severity).toBe("none");
    expect(result.confidenceBand.lower).toBeGreaterThan(0);
    expect(result.confidenceBand.upper).toBeGreaterThan(0);
    expect(result.referenceSource).toBeTruthy();
    expect(result.verifiedAt).toBeTruthy();
  });

  test("flags grossly implausible rate (MAX_CO2_PER_XLM level)", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 100 }] }); // 100000 g/XLM
    pool.query.mockResolvedValueOnce({ rows: [] });
    // Update project status
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await verifyProjectCO2Rate({
      ...MOCK_PROJECT,
      co2_offset_kg: 100,
    });

    expect(result.isPlausible).toBe(false);
    expect(result.severity).toBe("critical");
    expect(result.flagReason).toMatch(/exceeds/);
  });

  test("handles database errors gracefully during insert/update", async () => {
    // First call succeeds (claimedRate lookup)
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 2 }] });
    // Second call fails (INSERT INTO co2_verification_runs)
    pool.query.mockRejectedValueOnce(new Error("DB connection lost"));

    const result = await verifyProjectCO2Rate(MOCK_PROJECT);

    expect(result.error).toBe("DB connection lost");
    expect(result.isPlausible).toBe(false);
    expect(result.severity).toBe("warning");
  });

  test("writes a co2_verification_runs row on success", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 2 }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    await verifyProjectCO2Rate(MOCK_PROJECT);

    // Second call should be INSERT INTO co2_verification_runs
    expect(pool.query).toHaveBeenCalledTimes(2);
    const [sql, values] = pool.query.mock.calls[1];
    expect(sql).toMatch(/INSERT INTO co2_verification_runs/);
    expect(values[0]).toBe(MOCK_PROJECT.id);
  });

  test("updates project status when flagged", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 50 }] });
    pool.query.mockResolvedValueOnce({ rows: [] }); // insert run
    pool.query.mockResolvedValueOnce({ rows: [] }); // update project

    const result = await verifyProjectCO2Rate({
      ...MOCK_PROJECT,
      co2_offset_kg: 50,
    });

    expect(pool.query).toHaveBeenCalledTimes(3);
    const [updateSql] = pool.query.mock.calls[2];
    expect(updateSql).toMatch(/UPDATE projects/);
    expect(updateSql).toMatch(/co2_verification_status/);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Batch verification — runVerificationForAllProjects
// ═══════════════════════════════════════════════════════════════════════════

describe("runVerificationForAllProjects", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CO2_VERIFIER_GS_API_URL;
    delete process.env.CO2_VERIFIER_GFW_API_URL;
  });

  test("processes all active projects and returns summary", async () => {
    // Mock: project listing
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "proj-1",
          name: "Project 1",
          category: "Solar Energy",
          location: "India",
          wallet_address: "GAAA1",
          co2_offset_kg: 3,
        },
        {
          id: "proj-2",
          name: "Project 2",
          category: "Reforestation",
          location: "Brazil",
          wallet_address: "GAAA2",
          co2_offset_kg: 2,
        },
      ],
    });
    // Mock: each project lookup + insert (4 more calls)
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 3 }] });
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [{ co2_offset_kg: 2 }] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const summary = await runVerificationForAllProjects();

    expect(summary.total).toBe(2);
    expect(summary.plausible).toBeGreaterThanOrEqual(0);
    expect(summary.results).toHaveLength(2);
  });

  test("returns zero projects when none active", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    const summary = await runVerificationForAllProjects();

    expect(summary.total).toBe(0);
    expect(summary.results).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Cron scheduling
// ═══════════════════════════════════════════════════════════════════════════

describe("startCO2VerificationCron", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.CO2_VERIFICATION_CRON;
  });

  test("disables cron when CO2_VERIFICATION_CRON=disabled", async () => {
    process.env.CO2_VERIFICATION_CRON = "disabled";

    await startCO2VerificationCron();

    // pg-boss should not have been instantiated
    const PgBoss = require("pg-boss");
    expect(PgBoss).not.toHaveBeenCalled();
  });

  test("schedules cron with default weekly schedule", async () => {
    await startCO2VerificationCron();

    const PgBoss = require("pg-boss");
    expect(PgBoss).toHaveBeenCalled();
  });
});

describe("stopCO2VerificationCron", () => {
  test("handles null boss gracefully", async () => {
    // Should not throw
    await expect(stopCO2VerificationCron()).resolves.not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. IPCC constants
// ═══════════════════════════════════════════════════════════════════════════

describe("IPCC_TIER1_FACTORS", () => {
  test("all zone factors are defined and positive", () => {
    const zones = [
      "reforestation_tropical",
      "reforestation_temperate",
      "reforestation_boreal",
      "reforestation_default",
      "soil_carbon",
    ];

    for (const zone of zones) {
      expect(IPCC_TIER1_FACTORS[zone]).toBeDefined();
      expect(IPCC_TIER1_FACTORS[zone].tco2_per_ha_yr).toBeGreaterThan(0);
    }
  });

  test("tropical > temperate > boreal (expected carbon gradient)", () => {
    const t = IPCC_TIER1_FACTORS.reforestation_tropical.tco2_per_ha_yr;
    const temp = IPCC_TIER1_FACTORS.reforestation_temperate.tco2_per_ha_yr;
    const b = IPCC_TIER1_FACTORS.reforestation_boreal.tco2_per_ha_yr;

    expect(t).toBeGreaterThan(temp);
    expect(temp).toBeGreaterThan(b);
  });
});
