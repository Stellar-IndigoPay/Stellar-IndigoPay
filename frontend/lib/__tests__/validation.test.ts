/**
 * lib/__tests__/validation.test.ts
 *
 * Unit tests for Zod validation schemas:
 * - Stellar address validator
 * - XLM amount validator
 * - submitProjectSchema
 * - verificationRequestSchema
 */
import {
  stellarAddress,
  xlmAmount,
  submitProjectSchema,
  verificationRequestSchema,
} from "@/lib/validation";

// ── Stellar Address ───────────────────────────────────────────────────────────

describe("stellarAddress", () => {
  test("accepts a valid Stellar public key (G-address)", () => {
    // Valid testnet G-address
    const result = stellarAddress.safeParse(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    expect(result.success).toBe(true);
  });

  test("rejects an address with wrong checksum", () => {
    // Same length but invalid checksum
    const result = stellarAddress.safeParse(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("Invalid Stellar");
    }
  });

  test("rejects an address that is too short", () => {
    const result = stellarAddress.safeParse("GABC");
    expect(result.success).toBe(false);
  });

  test("rejects an address starting with wrong prefix", () => {
    // S-prefix is for secret keys
    const result = stellarAddress.safeParse(
      "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB2L",
    );
    expect(result.success).toBe(false);
  });

  test("rejects an empty string", () => {
    const result = stellarAddress.safeParse("");
    expect(result.success).toBe(false);
  });

  test("rejects non-alphanumeric garbage", () => {
    const result = stellarAddress.safeParse("not-a-stellar-address-!@#$%");
    expect(result.success).toBe(false);
  });

  test("accepts address with surrounding whitespace (trims)", () => {
    // The .trim() should handle this
    const result = stellarAddress.safeParse(
      "  GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF  ",
    );
    expect(result.success).toBe(true);
  });
});

// ── XLM Amount ────────────────────────────────────────────────────────────────

describe("xlmAmount", () => {
  test("accepts a valid XLM amount as string", () => {
    const result = xlmAmount.safeParse("123.4567890");
    expect(result.success).toBe(true);
  });

  test("rejects zero amount", () => {
    const result = xlmAmount.safeParse("0");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("greater than 0"))).toBe(true);
    }
  });

  test("rejects negative amount", () => {
    const result = xlmAmount.safeParse("-5");
    expect(result.success).toBe(false);
  });

  test("rejects more than 7 decimal places", () => {
    const result = xlmAmount.safeParse("1.12345678");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes("decimal"))).toBe(true);
    }
  });

  test("accepts a whole number string", () => {
    const result = xlmAmount.safeParse("50000");
    expect(result.success).toBe(true);
  });

  test("rejects non-numeric string", () => {
    const result = xlmAmount.safeParse("abc");
    expect(result.success).toBe(false);
  });
});

// ── submitProjectSchema ───────────────────────────────────────────────────────

describe("submitProjectSchema", () => {
  const validPayload = {
    name: "Acme Solar Farm",
    category: "Solar Energy",
    description:
      "A large-scale solar installation providing clean energy to rural communities across East Africa.",
    location: "Nairobi, Kenya",
    goalXLM: "50000",
    walletAddress:
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    organization: {
      name: "Acme Climate Foundation",
      website: "https://acme.org",
      country: "Kenya",
      contactEmail: "hello@acme.org",
    },
    co2Methodology: {
      name: "Verra VM0007",
      verificationBody: "Gold Standard",
      annualTonnesCO2: "1200",
      documentUrl: "https://acme.org/methodology.pdf",
    },
    impactMetrics: ["co2-reduction"],
  };

  test("accepts a fully valid payload", () => {
    const result = submitProjectSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test("accepts empty website and documentUrl", () => {
    const payload = {
      ...validPayload,
      organization: { ...validPayload.organization, website: "" },
      co2Methodology: { ...validPayload.co2Methodology, documentUrl: "" },
    };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });

  test("rejects missing required fields", () => {
    const result = submitProjectSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("rejects invalid nested organization email", () => {
    const payload = {
      ...validPayload,
      organization: { ...validPayload.organization, contactEmail: "not-email" },
    };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      const emailIssues = result.error.issues.filter((i) =>
        i.path.includes("contactEmail"),
      );
      expect(emailIssues.length).toBeGreaterThan(0);
    }
  });

  test("rejects project name too short", () => {
    const payload = { ...validPayload, name: "AB" };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects description too short (less than 50 characters)", () => {
    const payload = { ...validPayload, description: "Too short" };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path.includes("description")),
      ).toBe(true);
    }
  });

  test("rejects invalid wallet address in full schema", () => {
    const payload = {
      ...validPayload,
      walletAddress: "not-a-wallet",
    };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects invalid category not in PROJECT_CATEGORIES", () => {
    const payload = {
      ...validPayload,
      category: "InvalidCategory",
    };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects invalid co2Methodology annualTonnesCO2 (not whole number)", () => {
    const payload = {
      ...validPayload,
      co2Methodology: {
        ...validPayload.co2Methodology,
        annualTonnesCO2: "12.5",
      },
    };
    const result = submitProjectSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });
});

// ── verificationRequestSchema ────────────────────────────────────────────────

describe("verificationRequestSchema", () => {
  const validPayload = {
    organizationName: "Acme Climate Foundation",
    organizationWebsite: "https://acme.org",
    organizationCountry: "Kenya",
    contactEmail: "hello@acme.org",
    walletAddress:
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    projectName: "Acme Solar Farm",
    projectCategory: "Solar Energy",
    projectLocation: "Nairobi, Kenya",
    projectDescription: "A large-scale solar project in East Africa.",
    co2PerXLM: "0.05",
    expectedAnnualTonnesCO2: "1200",
    notes: "Please review ASAP.",
  };

  test("accepts a fully valid payload", () => {
    const result = verificationRequestSchema.safeParse(validPayload);
    expect(result.success).toBe(true);
  });

  test("accepts optional fields as empty or omitted", () => {
    const result = verificationRequestSchema.safeParse({
      organizationName: "Acme",
      contactEmail: "hello@acme.org",
      walletAddress:
        "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      projectName: "Solar Farm",
      projectCategory: "Solar Energy",
      projectLocation: "Nairobi",
      co2PerXLM: "0.05",
    });
    expect(result.success).toBe(true);
  });

  test("rejects invalid contact email", () => {
    const payload = { ...validPayload, contactEmail: "bad-email" };
    const result = verificationRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects invalid wallet address", () => {
    const payload = { ...validPayload, walletAddress: "bad-wallet" };
    const result = verificationRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("rejects negative co2PerXLM", () => {
    const payload = { ...validPayload, co2PerXLM: "-0.05" };
    const result = verificationRequestSchema.safeParse(payload);
    expect(result.success).toBe(false);
  });

  test("accepts zero co2PerXLM", () => {
    const payload = { ...validPayload, co2PerXLM: "0" };
    const result = verificationRequestSchema.safeParse(payload);
    expect(result.success).toBe(true);
  });
});
