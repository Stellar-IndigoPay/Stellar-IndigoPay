/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: "jsdom",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "tsconfig.test.json" }],
  },
  moduleFileExtensions: ["ts", "js", "json"],
  testMatch: ["**/__tests__/**/*.test.ts"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  setupFiles: ["./jest.setup.js"],
  transformIgnorePatterns: ["/node_modules/(?!.*\\.ts$)"],
  moduleNameMapper: {
    "^@stellar-indigopay/fixtures$": "<rootDir>/../packages/fixtures/dist/index",
  },
  collectCoverageFrom: [
    "src/overlay-helpers.ts",
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
