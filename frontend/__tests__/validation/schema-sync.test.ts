import { z } from "zod";
import * as frontendSchemas from "../../lib/validation/schemas";

// Require the backend schemas dynamically using relative path
const backendSchemas = require("../../../backend/src/validators/schemas");

describe("Schema Synchronization Tests", () => {
  // Helper to assert that two schemas have equivalent fields and field types
  function assertShapeEqual(frontendObject: any, backendObject: any, keysToCompare?: string[]) {
    const fShape = frontendObject.shape;
    const bShape = backendObject.shape;

    const fKeys = keysToCompare || Object.keys(fShape);
    const bKeys = keysToCompare || Object.keys(bShape);

    expect(fKeys.sort()).toEqual(bKeys.sort());

    for (const key of fKeys) {
      const fField = fShape[key];
      const bField = bShape[key];

      expect(fField).toBeDefined();
      expect(bField).toBeDefined();

      // Compare their Zod type names (e.g. ZodString, ZodEnum, etc.)
      expect(fField._def.typeName).toBe(bField._def.typeName);
    }
  }

  test("profileSchema matches backend definition", () => {
    assertShapeEqual(frontendSchemas.profileSchema, backendSchemas.profileSchema);
  });

  test("verificationRequestSchema matches backend verificationSchema", () => {
    assertShapeEqual(frontendSchemas.verificationRequestSchema, backendSchemas.verificationSchema);
  });

  test("projectSubmissionSchema matches backend projectSubmissionSchema", () => {
    assertShapeEqual(frontendSchemas.projectSubmissionSchema, backendSchemas.projectSubmissionSchema);
  });

  test("overlapping fields of donationSchema match backend donationSchema", () => {
    // Compare projectId and message, which are present on both frontend and backend
    assertShapeEqual(frontendSchemas.donationSchema, backendSchemas.donationSchema, ["projectId", "message"]);
  });

  test("walletAddressSchema and backend stellarAddress reject invalid addresses identically", () => {
    const fSchema = frontendSchemas.walletAddressSchema;
    const bSchema = backendSchemas.stellarAddress;

    const validAddress = "GAUUCYNO24CCKKNOMT5AS6D73J6QMYC5IJI64H4ZBJL7NQUETW3KOO4J";
    const invalidAddress = "GINVALID123";

    expect(fSchema.safeParse(validAddress).success).toBe(true);
    expect(bSchema.safeParse(validAddress).success).toBe(true);

    expect(fSchema.safeParse(invalidAddress).success).toBe(false);
    expect(bSchema.safeParse(invalidAddress).success).toBe(false);
  });

  test("stellarTxHashSchema and backend transactionHash reject invalid hashes identically", () => {
    const fSchema = frontendSchemas.stellarTxHashSchema;
    const bSchema = backendSchemas.transactionHash;

    const validHash = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";
    const invalidHash = "not-a-hash";

    expect(fSchema.safeParse(validHash).success).toBe(true);
    expect(bSchema.safeParse(validHash).success).toBe(true);

    expect(fSchema.safeParse(invalidHash).success).toBe(false);
    expect(bSchema.safeParse(invalidHash).success).toBe(false);
  });
});
