const nextJest = require("next/jest");

const createJestConfig = nextJest({
  // Path to the Next.js app so next/jest can load next.config and .env files
  dir: "./",
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jest-environment-jsdom",
  setupFiles: ["<rootDir>/jest.env.js"],
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
    "^zod$": "<rootDir>/node_modules/zod",
  },
  // Only run unit/snapshot tests here; Playwright e2e lives in /e2e
  testMatch: ["<rootDir>/**/__tests__/**/*.test.{ts,tsx}"],
  collectCoverageFrom: [
    "components/EmptyState.tsx",
    "components/DonorProfileSkeleton.tsx",
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

module.exports = createJestConfig(customJestConfig);
