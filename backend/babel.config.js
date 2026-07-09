/**
 * backend/babel.config.js
 *
 * Used only by babel-jest (configured in jest.config.js via
 * transformIgnorePatterns). The test suite needs to require ESM-only
 * packages (uuid 10+, @stellar/stellar-sdk 12+, pino 10+, prom-client
 * 15+) which ship as `export { … }` modules. babel-jest transforms
 * them down to CommonJS so `require()` works inside jest.
 *
 * `targets.node: "current"` tells preset-env to emit the syntax the
 * currently-running Node.js supports, so we don't waste cycles
 * down-leveling for ancient engines.
 */
"use strict";

module.exports = {
  presets: [
    [
      "@babel/preset-env",
      {
        targets: { node: "current" },
      },
    ],
  ],
};
