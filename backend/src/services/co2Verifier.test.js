"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

const pool = require("../db/pool");
const {
  CATEGORY_BENCHMARKS,
  verifyCO2Rate,
  applyCO2VerificationToProject,
} = require("./co2Verifier");

describe("verifyCO2Rate", () => {
  test("rate within typical range is verified", async () => {
    // Reforestation benchmark is 2.5 kg/XLM; 2.0 is well within range.
    const result = verifyCO2Rate("Reforestation", 2.0);
    expect(result.status).toBe("verified");
    expect(result.reason).toBeNull();
    expect(result.multiplier).toBeCloseTo(0.8);
    expect(result.benchmark.category).toBe("Reforestation");
  });

  test("rate at exactly 3× the benchmark is still verified", () => {
    // Boundary: review only kicks in strictly above 3×.
    const result = verifyCO2Rate("Reforestation", 7.5);
    expect(result.status).toBe("verified");
  });

  test("rate 5× the benchmark is marked for review", () => {
    // Solar Energy benchmark is 3.0 kg/XLM; 15 is 5×.
    const result = verifyCO2Rate("Solar Energy", 15);
    expect(result.status).toBe("review");
    expect(result.multiplier).toBeCloseTo(5);
    expect(result.reason).toMatch(/Solar Energy/);
  });

  test("rate 15× the benchmark is flagged", () => {
    // Solar Energy benchmark is 3.0 kg/XLM; 45 is 15×.
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
    // 'Other' benchmark is 2.0 kg/XLM; 30 is 15× → flagged.
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
