#!/usr/bin/env node
/**
 * Custom OpenAPI validation script for Stellar-IndigoPay.
 *
 * Validates project-specific conventions that Spectral's built-in rules
 * cannot express (e.g., requiring a specific response status code on
 * mutation endpoints).
 *
 * Usage:
 *   node scripts/validate-openapi.js
 *
 * Returns exit code 0 on success, 1 on failure.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const SPEC_PATH = path.resolve(__dirname, "..", "docs", "api", "openapi.yaml");

/**
 * Parse the OpenAPI YAML spec into a JavaScript object.
 */
function loadSpec(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw);
}

/**
 * Check that every POST, PATCH, and DELETE endpoint declares a 429 response.
 */
function check429OnMutations(spec, errors) {
  const paths = spec.paths || {};
  const MUTATION_METHODS = ["post", "patch", "delete"];

  for (const [pathName, pathItem] of Object.entries(paths)) {
    for (const method of MUTATION_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const responses = operation.responses || {};
      if (!("429" in responses)) {
        errors.push(
          `❌ Missing 429 response: ${method.toUpperCase()} ${pathName}`
        );
      }
    }
  }
}

/**
 * Check that every inline response (not a $ref) has a description.
 */
function checkResponseDescriptions(spec, errors) {
  const paths = spec.paths || {};
  const ALL_METHODS = ["get", "post", "patch", "delete", "put"];

  for (const [pathName, pathItem] of Object.entries(paths)) {
    for (const method of ALL_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      const responses = operation.responses || {};
      for (const [statusCode, responseObj] of Object.entries(responses)) {
        // Skip $ref-only responses — description lives in the component
        if (responseObj && "$ref" in responseObj) continue;

        if (
          !responseObj ||
          typeof responseObj !== "object" ||
          !responseObj.description ||
          typeof responseObj.description !== "string"
        ) {
          errors.push(
            `⚠️  Missing description: ${method.toUpperCase()} ${pathName} → ${statusCode}`
          );
        }
      }
    }
  }
}

/**
 * Check that every operation has a summary.
 */
function checkOperationSummaries(spec, errors) {
  const paths = spec.paths || {};
  const ALL_METHODS = ["get", "post", "patch", "delete", "put"];

  for (const [pathName, pathItem] of Object.entries(paths)) {
    for (const method of ALL_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      if (!operation.summary) {
        errors.push(
          `⚠️  Missing summary: ${method.toUpperCase()} ${pathName}`
        );
      }
    }
  }
}

/**
 * Main entry point.
 */
function main() {
  let exitCode = 0;
  const errors = [];

  console.log("\n🔍 Validating OpenAPI spec against project conventions...\n");

  try {
    const spec = loadSpec(SPEC_PATH);
    console.log(`📄 Loaded spec: ${spec.info?.title || "unknown"} v${spec.info?.version || "?"}\n`);

    check429OnMutations(spec, errors);
    checkResponseDescriptions(spec, errors);
    checkOperationSummaries(spec, errors);

    if (errors.length === 0) {
      console.log("✅ All project-specific validations passed!\n");
    } else {
      console.log(errors.join("\n") + "\n");
      console.log(`📊 ${errors.length} issue(s) found:\n`);
      const byType = {};
      for (const err of errors) {
        const type = err.startsWith("❌") ? "Missing 429" : err.startsWith("⚠️  Missing description") ? "Missing description" : "Missing summary";
        byType[type] = (byType[type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(byType)) {
        const isError = type === "Missing 429";
        console.log(`   ${isError ? "❌" : "⚠️"}  ${type}: ${count}`);
      }
      console.log("");
      exitCode = errors.some((e) => e.startsWith("❌")) ? 1 : 0;
    }
  } catch (err) {
    console.error(`\n💥 Failed to validate spec: ${err.message}\n`);
    exitCode = 1;
  }

  process.exit(exitCode);
}

main();
