#!/usr/bin/env node
/**
 * scripts/verify-csp.mjs — CI-enforced CSP whitelist check (issue #1096,
 * Workstream 3).
 *
 * The issue requires that "the CSP header matches the whitelist on every
 * deployed page (CI-enforced)".  The authoritative policy is generated at
 * runtime by `middleware.ts` (and mirrored statically for non-edge routes in
 * `next.config.mjs`), so this script statically asserts that both sources
 * still contain every required directive.  It runs in GitHub Actions as part
 * of the frontend pipeline, so a regression in the policy fails CI before
 * deploy — no need to fetch a live page.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const middleware = readFileSync(join(root, "middleware.ts"), "utf8");
const nextConfig = readFileSync(join(root, "next.config.mjs"), "utf8");

const REQUIRED = [
  ["middleware.ts", "object-src 'none'"],
  ["middleware.ts", "base-uri 'self'"],
  ["middleware.ts", "frame-ancestors 'none'"],
  ["middleware.ts", "default-src 'self'"],
  ["middleware.ts", "form-action 'self'"],
  ["middleware.ts", "require-trusted-types-for 'script'"],
  ["middleware.ts", "trusted-types dompurify"],
  // nosniff / referrer headers are emitted statically for non-edge routes.
  ["next.config.mjs", "X-Content-Type-Options"],
  ["next.config.mjs", "Referrer-Policy"],
];

const FORBIDDEN = [
  // 'unsafe-eval' is strictly dev-only (Fast Refresh); production bundles
  // never need it.  The middleware guards it with NODE_ENV, but the script
  // must not reference it outside that guard.
  ["middleware.ts", "unsafe-eval"],
];

let failed = false;

for (const [file, directive] of REQUIRED) {
  const source = file === "middleware.ts" ? middleware : nextConfig;
  if (!source.includes(directive)) {
    console.error(`✗ CSP whitelist violation: ${file} is missing "${directive}"`);
    failed = true;
  } else {
    console.log(`✓ ${file} contains ${directive}`);
  }
}

for (const [file, directive] of FORBIDDEN) {
  const source = file === "middleware.ts" ? middleware : nextConfig;
  // Every mention must sit within the dev-only guard: check each line that
  // contains the token against a ±3 line window for the NODE_ENV check.
  const lines = source.split("\n");
  const bad = [];
  lines.forEach((line, i) => {
    if (!line.includes(directive)) return;
    const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
    // Comments that merely mention the token are fine; the guarded array
    // literal is within the window of the development check.
    const isComment = line.trim().startsWith("//") || line.trim().startsWith("*");
    if (!isComment && !window.includes('"development"')) {
      bad.push(line.trim());
    }
  });
  if (bad.length > 0) {
    console.error(
      `✗ CSP violation: "${directive}" appears outside the dev-only guard:\n${bad
        .map((l) => `    ${l}`)
        .join("\n")}`,
    );
    failed = true;
  } else {
    console.log(`✓ ${directive} only appears inside the dev guard`);
  }
}

if (failed) {
  console.error("\nCSP whitelist check FAILED — see violations above.");
  process.exit(1);
}
console.log("\nCSP whitelist check passed.");
