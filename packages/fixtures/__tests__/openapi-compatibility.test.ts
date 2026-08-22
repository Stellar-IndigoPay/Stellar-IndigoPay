/**
 * OpenAPI compatibility test.
 *
 * Validates that fixture output for API-facing objects matches the
 * canonical OpenAPI schemas. This ensures fixtures cannot drift from
 * the real API contract — a deliberate API-shape change will fail
 * this test until the fixtures are updated.
 */

import {
  project,
  donation,
  match,
  profile,
  campaign,
  milestone,
  update,
} from "../src/index";
import {
  validateAgainstSchema,
  getSchemaNames,
  loadSpec,
} from "../src/validation-entry";

// ── Schema availability ───────────────────────────────────────────────

describe("OpenAPI spec", () => {
  test("spec loads successfully", () => {
    const spec = loadSpec();
    expect(spec).toBeDefined();
    expect(spec.openapi).toBe("3.0.3");
    expect(spec.info?.title).toBe("Stellar-IndigoPay API");
  });

  test("expected schemas are defined", () => {
    const names = getSchemaNames();
    expect(names).toContain("Project");
    expect(names).toContain("Donation");
    expect(names).toContain("DonationMatch");
    expect(names).toContain("Profile");
    expect(names).toContain("Campaign");
    expect(names).toContain("Milestone");
    expect(names).toContain("ProjectUpdate");
    expect(names).toContain("ErrorResponse");
  });
});

// ── Helper: strip internal fixture keys before schema validation ───────

function stripInternalKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const { seed: _seed, ...rest } = obj;
  return rest;
}

// ── Project ───────────────────────────────────────────────────────────

describe("Project fixture vs OpenAPI schema", () => {
  test("default project validates against Project schema", () => {
    const p = stripInternalKeys(project() as any);
    const result = validateAgainstSchema(p, "Project");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("Project validation errors:", result.errors);
    }
  });

  test("project with overrides still validates", () => {
    const p = stripInternalKeys(project({
      name: "Custom Project",
      status: "paused",
      verified: false,
      tags: ["test", "fixture"],
    }) as any);
    const result = validateAgainstSchema(p, "Project");
    expect(result.valid).toBe(true);
  });

  test("multiple seeds all validate", () => {
    for (let seed = 0; seed < 20; seed++) {
      const p = stripInternalKeys(project({ seed }) as any);
      const result = validateAgainstSchema(p, "Project");
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error(`Project seed ${seed} validation errors:`, result.errors);
      }
    }
  });
});

// ── Donation ──────────────────────────────────────────────────────────

describe("Donation fixture vs OpenAPI schema", () => {
  test("default donation validates against Donation schema", () => {
    const d = stripInternalKeys(donation() as any);
    const result = validateAgainstSchema(d, "Donation");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("Donation validation errors:", result.errors);
    }
  });

  test("anonymous donation validates", () => {
    const d = stripInternalKeys(donation({ anonymous: true, donorAddress: null }) as any);
    const result = validateAgainstSchema(d, "Donation");
    expect(result.valid).toBe(true);
  });

  test("multiple seeds all validate", () => {
    for (let seed = 0; seed < 20; seed++) {
      const d = stripInternalKeys(donation({ seed }) as any);
      const result = validateAgainstSchema(d, "Donation");
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error(`Donation seed ${seed} validation errors:`, result.errors);
      }
    }
  });
});

// ── DonationMatch ─────────────────────────────────────────────────────

describe("DonationMatch fixture vs OpenAPI schema", () => {
  test("default match validates against DonationMatch schema", () => {
    const m = stripInternalKeys(match() as any);
    const result = validateAgainstSchema(m, "DonationMatch");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("DonationMatch validation errors:", result.errors);
    }
  });

  test("multiple seeds all validate", () => {
    for (let seed = 0; seed < 20; seed++) {
      const m = stripInternalKeys(match({ seed }) as any);
      const result = validateAgainstSchema(m, "DonationMatch");
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error(`DonationMatch seed ${seed} validation errors:`, result.errors);
      }
    }
  });
});

// ── Profile ───────────────────────────────────────────────────────────

describe("Profile fixture vs OpenAPI schema", () => {
  test("default profile validates against Profile schema", () => {
    const p = stripInternalKeys(profile() as any);
    const result = validateAgainstSchema(p, "Profile");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("Profile validation errors:", result.errors);
    }
  });

  test("multiple seeds all validate", () => {
    for (let seed = 0; seed < 20; seed++) {
      const p = stripInternalKeys(profile({ seed }) as any);
      const result = validateAgainstSchema(p, "Profile");
      expect(result.valid).toBe(true);
      if (!result.valid) {
        console.error(`Profile seed ${seed} validation errors:`, result.errors);
      }
    }
  });
});

// ── Campaign ──────────────────────────────────────────────────────────

describe("Campaign fixture vs OpenAPI schema", () => {
  test("default campaign validates against Campaign schema", () => {
    const c = stripInternalKeys(campaign() as any);
    const result = validateAgainstSchema(c, "Campaign");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("Campaign validation errors:", result.errors);
    }
  });
});

// ── Milestone ─────────────────────────────────────────────────────────

describe("Milestone fixture vs OpenAPI schema", () => {
  test("default milestone validates against Milestone schema", () => {
    const m = stripInternalKeys(milestone() as any);
    const result = validateAgainstSchema(m, "Milestone");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("Milestone validation errors:", result.errors);
    }
  });
});

// ── ProjectUpdate ─────────────────────────────────────────────────────

describe("ProjectUpdate fixture vs OpenAPI schema", () => {
  test("default update validates against ProjectUpdate schema", () => {
    const u = stripInternalKeys(update() as any);
    const result = validateAgainstSchema(u, "ProjectUpdate");
    expect(result.valid).toBe(true);
    if (!result.valid) {
      console.error("ProjectUpdate validation errors:", result.errors);
    }
  });
});

// ── Negative: invalid data should fail ────────────────────────────────

describe("Negative: invalid data fails validation", () => {
  test("empty object fails Project validation (wrong types for known fields)", () => {
    const invalidProject = { id: 123, name: 456 }; // wrong types
    const result = validateAgainstSchema(invalidProject, "Project");
    expect(result.valid).toBe(false);
    expect(result.errors).not.toBeNull();
  });

  test("donation with wrong type for amount fails", () => {
    const invalidDonation = {
      id: "test",
      projectId: "test",
      amount: 123, // should be string
      transactionHash: "abc",
      createdAt: "2024-01-01T00:00:00Z",
      anonymous: false,
    };
    const result = validateAgainstSchema(invalidDonation, "Donation");
    expect(result.valid).toBe(false);
  });

  test("non-existent schema returns error", () => {
    const result = validateAgainstSchema({}, "NonExistentSchema");
    expect(result.valid).toBe(false);
    expect(result.errors).not.toBeNull();
  });
});
