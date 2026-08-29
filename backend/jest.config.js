"use strict";
/**
 * jest.config.js — Stellar-IndigoPay backend
 *
 * Notes:
 *   - testRunner is jest-circus (matches the prior config).
 *   - transformIgnorePatterns excludes the ESM-only deps that ship as
 *     `export { … }` modules so jest's CJS transform will compile them.
 *     The full list of ESM-only deps surfaced during this work:
 *       - uuid (10+ is ESM-only)
 *       - @stellar/stellar-sdk (ESM in v12+)
 *       - pino / pino-http (ESM in v10+)
 *       - prom-client (ESM since v15)
 *     We pass these through babel-jest so the test suite can require()
 *     them as if they were CJS.
 *   - testPathIgnorePatterns keeps load-modules.js out of the suite
 *     (it's a manual smoke test, not a unit test).
 */
module.exports = {
  testRunner: "jest-circus/runner",
  testEnvironment: "node",
  setupFiles: ["<rootDir>/test-setup.js"],
  testTimeout: 20000,
  transformIgnorePatterns: [
    "node_modules/(?!(uuid|@stellar/stellar-sdk|pino|pino-http|prom-client)/)",
  ],
  testPathIgnorePatterns: [
    "/node_modules/",
    "/scripts/load-modules.js",
    // Chaos harness runs only when CHAOS_TEST=1 (see test/chaos/workerChaos.test.js).
    // Exclude it from the regular test run so it never runs without the flag.
    ...(!process.env.CHAOS_TEST ? ["/test/chaos/"] : []),
  ],
  collectCoverageFrom: [
    "src/errors.js",
    "src/config/apiVersions.js",
    "src/middleware/requestId.js",
  ],
  coverageThreshold: {
    global: {
      statements: 99.5,
      branches: 99.5,
      functions: 99.5,
      lines: 99.5,
    },
  },
};
