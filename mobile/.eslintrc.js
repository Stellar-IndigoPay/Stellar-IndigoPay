/**
 * mobile/.eslintrc.js
 *
 * Mirrors the typecheck-first posture of mobile/tsconfig.json: TypeScript
 * already catches most correctness bugs, so lint here is scoped to dead
 * code and require/import hygiene rather than duplicating the type checker.
 */
module.exports = {
  root: true,
  parser: "@typescript-eslint/parser",
  plugins: ["@typescript-eslint"],
  parserOptions: {
    ecmaVersion: 2021,
    sourceType: "module",
    ecmaFeatures: { jsx: true },
  },
  env: { es2021: true, node: true, browser: true },
  globals: { __DEV__: "readonly" },
  extends: ["eslint:recommended", "plugin:@typescript-eslint/recommended"],
  rules: {
    // TS-aware version replaces the base rule.
    "no-unused-vars": "off",
    "@typescript-eslint/no-unused-vars": "error",

    // The codebase leans on `any` at Stellar SDK / native-module boundaries
    // (SDK response shapes, error catches, JSX ref escape hatches). Making
    // this an error would require a broad, risky type-modeling pass that is
    // out of scope for CI hardening (#926) — tracked separately.
    "@typescript-eslint/no-explicit-any": "off",

    // Dynamic require() is the standard pattern for swapping jest mocks
    // between test cases in this suite; banning it breaks legitimate tests.
    "@typescript-eslint/no-require-imports": "off",
  },
  ignorePatterns: [
    "node_modules/",
    ".expo/",
    "dist/",
    "babel.config.js",
    "app.config.js",
    "metro.config.js",
  ],
};
