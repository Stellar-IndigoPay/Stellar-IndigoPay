"use strict";

/**
 * jest.config.migrations.js
 *
 * Separate Jest configuration for the migration test harness.
 * Run with: npx jest --config jest.config.migrations.js
 *           or via npm script: npm run test:migrations
 *
 * Key differences from the main jest.config.js:
 *   - testMatch targets only test/migrations/
 *   - testTimeout is raised to 300 s (container boot + full chain)
 *   - maxWorkers=1 — migration tests must run serially; parallel DB
 *     container startups race for Docker resources and bloat CI time.
 *   - No coverage thresholds — the harness is the deliverable, not the
 *     source files it tests.
 *   - runInBand is implicit via maxWorkers=1.
 */
module.exports = {
  testRunner: "jest-circus/runner",
  testEnvironment: "node",
  testMatch: ["<rootDir>/test/migrations/**/*.test.js"],
  testTimeout: 300_000,
  maxWorkers: 1,
  setupFiles: ["<rootDir>/test-setup.js"],
  transformIgnorePatterns: [
    "node_modules/(?!(uuid|@stellar/stellar-sdk|pino|pino-http|prom-client)/)",
  ],
  // Verbose output so per-migration failures are immediately visible in CI logs
  verbose: true,
};
