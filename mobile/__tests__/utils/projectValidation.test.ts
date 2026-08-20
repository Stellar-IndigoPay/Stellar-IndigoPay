/**
 * __tests__/utils/projectValidation.test.ts
 *
 * Unit tests for the destination-validation helper used by the
 * Scan-to-Donate screen (issue #695). Verifies that a scanned wallet address
 * is resolved against the project registry and that only registered, active
 * projects are considered safe to donate to.
 */
import {
  resolveProjectByAddress,
  RegistryProject,
} from "../../utils/projectValidation";

const WALLET_A = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const WALLET_B = "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function project(overrides: Partial<RegistryProject> = {}): RegistryProject {
  return {
    id: "proj-1",
    name: "Amazon Reforestation",
    walletAddress: WALLET_A,
    status: "active",
    ...overrides,
  };
}

describe("resolveProjectByAddress", () => {
  it("returns found for a registered, active project", () => {
    const result = resolveProjectByAddress([project()], WALLET_A);
    expect(result).toEqual({ kind: "found", project: project() });
  });

  it("returns unknown when no project owns the address", () => {
    const result = resolveProjectByAddress([project()], WALLET_B);
    expect(result).toEqual({ kind: "unknown" });
  });

  it("returns unknown for an empty registry", () => {
    const result = resolveProjectByAddress([], WALLET_A);
    expect(result).toEqual({ kind: "unknown" });
  });

  it.each(["paused", "completed", "rejected"])(
    "returns inactive for a registered project with status %s",
    (status) => {
      const inactive = project({ status });
      const result = resolveProjectByAddress([inactive], WALLET_A);
      expect(result).toEqual({ kind: "inactive", project: inactive });
    },
  );

  it("treats a missing status as inactive (fail closed)", () => {
    const noStatus = project();
    delete noStatus.status;
    const result = resolveProjectByAddress([noStatus], WALLET_A);
    expect(result.kind).toBe("inactive");
  });

  it("matches the correct project when several are registered", () => {
    const target = project({ id: "proj-2", name: "Solar Microgrids", walletAddress: WALLET_B });
    const result = resolveProjectByAddress([project(), target], WALLET_B);
    expect(result).toEqual({ kind: "found", project: target });
  });
});
