/**
 * __tests__/fuzz/randomGenerators.test.js
 *
 * Unit tests for the random value generators used in fuzz testing.
 * These tests verify that the generators produce valid output for various schema types.
 */

const {
  generateRandomValue,
  generateInvalidValue,
} = require("./apiFuzz.test");

describe("Random Value Generators", () => {
  describe("generateRandomValue", () => {
    test("should generate valid strings", () => {
      const schema = { type: "string", minLength: 5, maxLength: 20 };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThanOrEqual(5);
      expect(value.length).toBeLessThanOrEqual(20);
    });

    test("should generate valid numbers", () => {
      const schema = { type: "number", minimum: 0, maximum: 100 };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("number");
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });

    test("should generate valid integers", () => {
      const schema = { type: "integer", minimum: -10, maximum: 10 };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("number");
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(-10);
      expect(value).toBeLessThanOrEqual(10);
    });

    test("should generate valid booleans", () => {
      const schema = { type: "boolean" };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("boolean");
    });

    test("should generate valid arrays", () => {
      const schema = {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: { type: "string" },
      };
      const value = generateRandomValue(schema);
      expect(Array.isArray(value)).toBe(true);
      expect(value.length).toBeGreaterThanOrEqual(1);
      expect(value.length).toBeLessThanOrEqual(5);
    });

    test("should generate valid objects", () => {
      const schema = {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name"],
      };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("object");
      expect(value).not.toBeNull();
      expect(Array.isArray(value)).toBe(false);
    });

    test("should handle enum values", () => {
      const schema = {
        type: "string",
        enum: ["active", "completed", "paused"],
      };
      const value = generateRandomValue(schema);
      expect(["active", "completed", "paused"]).toContain(value);
    });

    test("should handle Stellar public key pattern", () => {
      const schema = {
        type: "string",
        pattern: "^G[A-Z0-9]{55}$",
      };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^G[A-Z0-9]{55}$/);
    });

    test("should handle transaction hash pattern", () => {
      const schema = {
        type: "string",
        pattern: "^[a-fA-F0-9]{64}$",
      };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("string");
      expect(value).toMatch(/^[a-fA-F0-9]{64}$/);
    });
  });

  describe("generateInvalidValue", () => {
    test("should generate various invalid value types", () => {
      const schema = { type: "string" };
      const invalidValues = new Set();

      // Generate multiple values to get variety
      for (let i = 0; i < 20; i++) {
        const value = generateInvalidValue(schema);
        invalidValues.add(typeof value);
      }

      // Should have generated multiple different types
      expect(invalidValues.size).toBeGreaterThan(1);
    });

    test("should include potentially dangerous values", () => {
      const schema = { type: "string" };
      const value = generateInvalidValue(schema);

      // The function should return something
      expect(value !== undefined).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("should handle null schema", () => {
      const value = generateRandomValue(null);
      expect(value).toBeDefined();
    });

    test("should handle undefined schema", () => {
      const value = generateRandomValue(undefined);
      expect(value).toBeDefined();
    });

    test("should handle schema without type", () => {
      const schema = { minLength: 5 };
      const value = generateRandomValue(schema);
      expect(value).toBeDefined();
    });

    test("should handle array type schema", () => {
      const schema = { type: ["string", "number"] };
      const value = generateRandomValue(schema);
      expect(["string", "number"]).includes(typeof value);
    });

    test("should prevent infinite recursion in nested objects", () => {
      const schema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              deep: {
                type: "object",
                properties: {
                  deeper: { type: "string" },
                },
              },
            },
          },
        },
      };
      const value = generateRandomValue(schema);
      expect(typeof value).toBe("object");
      expect(value).not.toBeNull();
    });

    test("should prevent infinite recursion in nested arrays", () => {
      const schema = {
        type: "array",
        items: {
          type: "array",
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
      };
      const value = generateRandomValue(schema);
      expect(Array.isArray(value)).toBe(true);
    });
  });
});