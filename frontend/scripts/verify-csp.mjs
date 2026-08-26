#!/usr/bin/env node
/**
 * scripts/verify-csp.mjs — CI-enforced CSP whitelist check (issue #1096,
 * Workstream 3).
 *
 * The issue requires that "the CSP header matches the whitelist on every
 * deployed page (CI-enforced)".  The authoritative policy is generated at
 * runtime by `middleware.ts` (and mirrored statically for non-edge routes in
 * `next.config.mjs`).  This script therefore checks BOTH layers:
 *
 * 1. Static — both sources still contain every required directive, so a
 *    regression in the policy fails CI before deploy (fast, runs in the lint
 *    job where no server is available).
 * 2. Runtime — when `VERIFY_CSP_URL` is set, fetch a real served page and
 *    assert the actual response headers (CSP, Reporting-Endpoints,
 *    nosniff, Referrer-Policy) match the whitelist.  This proves the
 *    *deployed* middleware output, not just the source text.  Wired into the
 *    e2e job where a production `next start` server is already running.
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

// Directives that must be present in the *served* CSP header.
const RUNTIME_CSP_DIRECTIVES = [
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors",
  "default-src 'self'",
  "require-trusted-types-for 'script'",
  "trusted-types dompurify",
];

let failed = false;

function fail(message) {
  console.error(`✗ ${message}`);
  failed = true;
}

for (const [file, directive] of REQUIRED) {
  const source = file === "middleware.ts" ? middleware : nextConfig;
  if (!source.includes(directive)) {
    fail(`${file} is missing "${directive}"`);
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
    fail(`"${directive}" appears outside the dev-only guard:\n${bad
      .map((l) => `    ${l}`)
      .join("\n")}`);
  } else {
    console.log(`✓ ${directive} only appears inside the dev guard`);
  }
}

/**
 * Runtime layer: fetch a served page and assert the deployed middleware
 * headers.  Only runs when VERIFY_CSP_URL is set (the e2e job starts a
 * production `next start` server and reuses it here).
 */
async function verifyRuntimeHeaders(baseUrl) {
  const origin = String(baseUrl).replace(/\/+$/, "");
  let res;
  try {
    res = await fetch(`${origin}/`);
  } catch (err) {
    fail(`runtime: could not fetch ${origin}/ — ${err instanceof Error ? err.message : err}`);
    return;
  }

  const headers = res.headers;
  // Trusted Types (require-trusted-types-for / trusted-types) are delivered
  // via the Report-Only header by design (see middleware.ts), so the
  // whitelist spans BOTH served CSP headers, not just the enforcing one.
  const mainCsp = headers.get("content-security-policy") || "";
  const reportOnlyCsp = headers.get("content-security-policy-report-only") || "";
  const csp = `${mainCsp} ${reportOnlyCsp}`.trim();

  const headerChecks = [
    ["Content-Security-Policy header present", Boolean(csp)],
    [
      "Content-Security-Policy-Report-Only (Trusted Types) header present",
      Boolean(headers.get("content-security-policy-report-only")),
    ],
    ["Reporting-Endpoints header present", Boolean(headers.get("reporting-endpoints"))],
    [
      "X-Content-Type-Options: nosniff",
      (headers.get("x-content-type-options") || "").toLowerCase() === "nosniff",
    ],
    [
      "Referrer-Policy: strict-origin-when-cross-origin",
      (headers.get("referrer-policy") || "").toLowerCase() ===
        "strict-origin-when-cross-origin",
    ],
  ];

  for (const [label, ok] of headerChecks) {
    if (ok) {
      console.log(`✓ runtime ${label}`);
    } else {
      fail(`runtime ${label}`);
    }
  }

  for (const directive of RUNTIME_CSP_DIRECTIVES) {
    if (csp.includes(directive)) {
      console.log(`✓ runtime CSP contains ${directive}`);
    } else {
      fail(`runtime CSP is missing "${directive}" (got: ${csp.slice(0, 120)}…)`);
    }
  }

  // The issue forbids unsafe-eval in the production policy (dev-only guard).
  if (csp.includes("unsafe-eval")) {
    fail("runtime CSP contains unsafe-eval (dev-only token leaked to production)");
  } else {
    console.log("✓ runtime CSP has no unsafe-eval");
  }
}

if (process.env.VERIFY_CSP_URL) {
  await verifyRuntimeHeaders(process.env.VERIFY_CSP_URL);
}

if (failed) {
  console.error("\nCSP whitelist check FAILED — see violations above.");
  process.exit(1);
}
console.log("\nCSP whitelist check passed.");
