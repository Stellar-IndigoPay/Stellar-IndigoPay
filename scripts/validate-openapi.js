#!/usr/bin/env node
/**
 * Custom OpenAPI validation script for Stellar-IndigoPay.
 *
 * Validates project-specific conventions that Spectral's built-in rules
 * cannot express, and detects drift between the OpenAPI spec and the live
 * Express route surface:
 *
 *   1. Every POST/PATCH/DELETE endpoint declares a 429 response.
 *   2. Every inline response has a description.
 *   3. Every operation has a summary.
 *   4. Every documented endpoint is actually implemented (drift → CI fails).
 *      Undocumented-but-implemented endpoints are reported informatively —
 *      the spec intentionally documents only the public surface, so adding
 *      internal/admin/metrics routes is not itself a failure.
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
const routeSurface = require("./lib/routeSurface");

const SPEC_PATH = path.resolve(__dirname, "..", "docs", "api", "openapi.yaml");
const BACKEND_SRC_DIR = path.resolve(__dirname, "..", "backend", "src");

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
          `❌ Missing 429 response: ${method.toUpperCase()} ${pathName}`,
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
            `⚠️  Missing description: ${method.toUpperCase()} ${pathName} → ${statusCode}`,
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
          `⚠️  Missing summary: ${method.toUpperCase()} ${pathName}`,
        );
      }
    }
  }
}

/**
 * Detect drift between the documented spec routes and the implemented Express
 * routes.
 *
 * - `missing` (spec documents an endpoint the server does not serve) is a
 *   hard failure — it means the public contract has silently diverged.
 * - `extra` (implemented but undocumented) is returned separately so callers
 *   can report it without failing, since the spec documents only the public
 *   surface by design.
 *
 * @returns {{missing: string[], extra: string[]}}
 */
function checkRouteDrift(spec) {
  const specRoutes = routeSurface.collectSpecRoutes(spec);
  const implRoutes = routeSurface.collectImplementationRoutes(BACKEND_SRC_DIR);
  return routeSurface.detectDrift(specRoutes, implRoutes);
}

/**
 * Main entry point.
 */
function main() {
  let exitCode = 0;
  const errors = [];
  let drift = { missing: [], extra: [] };

  console.log("\n🔍 Validating OpenAPI spec against project conventions...\n");

  try {
    const spec = loadSpec(SPEC_PATH);
    console.log(
      `📄 Loaded spec: ${spec.info?.title || "unknown"} v${spec.info?.version || "?"}\n`,
    );

    check429OnMutations(spec, errors);
    checkResponseDescriptions(spec, errors);
    checkOperationSummaries(spec, errors);

    console.log("🔎 Checking for drift between spec and Express routes...\n");
    drift = checkRouteDrift(spec);

    for (const entry of drift.missing) {
      errors.push(`❌ Documented endpoint not implemented: ${entry}`);
    }

    if (errors.length === 0) {
      console.log("✅ All project-specific validations passed!\n");
    } else {
      console.log(errors.join("\n") + "\n");
      console.log(`📊 ${errors.length} issue(s) found:\n`);
      const byType = {};
      for (const err of errors) {
        const type =
          err.startsWith("❌ Missing 429") ||
          err.startsWith("❌ Documented endpoint not implemented")
            ? err.startsWith("❌ Missing 429")
              ? "Missing 429 response"
              : "Undocumented → removed endpoint (drift)"
            : err.startsWith("⚠️  Missing description")
              ? "Missing description"
              : "Missing summary";
        byType[type] = (byType[type] || 0) + 1;
      }
      for (const [type, count] of Object.entries(byType)) {
        const isError = type !== "Missing description" && type !== "Missing summary";
        console.log(`   ${isError ? "❌" : "⚠️"}  ${type}: ${count}`);
      }
      console.log("");
      exitCode = errors.some((e) => e.startsWith("❌")) ? 1 : 0;
    }

    // Undocumented-but-implemented routes are informational, not fatal: the
    // spec intentionally documents only the public API surface.
    if (drift.extra.length > 0) {
      console.log(
        `ℹ️  ${drift.extra.length} implemented route(s) are not in the spec (informational):\n`,
      );
      for (const entry of drift.extra) {
        console.log(`   ${entry}`);
      }
      console.log("");
    }
  } catch (err) {
    console.error(`\n💥 Failed to validate spec: ${err.message}\n`);
    exitCode = 1;
  }

  process.exit(exitCode);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadSpec,
  check429OnMutations,
  checkResponseDescriptions,
  checkOperationSummaries,
  checkRouteDrift,
  main,
  SPEC_PATH,
  BACKEND_SRC_DIR,
};
