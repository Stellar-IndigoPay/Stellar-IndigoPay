/**
 * __tests__/middleware.test.ts — Unit tests for middleware.ts CSP generation.
 *
 * Verifies the cache-safe CSP hardening from issue #689:
 *   - production `script-src` allows the FOUC inline script via SHA-256 hash
 *     (not a per-request nonce), so SSG / ISR / cached HTML never nonce-mismatches
 *   - `'unsafe-inline'`/`'unsafe-eval'` stay dev-only for Fast Refresh / HMR
 *   - reporting uses `report-to` alongside the legacy `report-uri`
 *
 * @jest-environment jsdom
 */

// next/server pulls in the web `Request`/`Response` globals that jsdom does
// not implement. `buildCsp` never touches them, so stub the module out.
jest.mock("next/server", () => ({
  NextResponse: { next: jest.fn() },
  NextRequest: class {},
}));

import { buildCsp, buildTrustedTypesReportOnlyCsp, middleware } from "@/middleware";
import { FOUC_THEME_SCRIPT_HASH } from "@/lib/csp";

const originalNodeEnv = process.env.NODE_ENV;

// NODE_ENV is typed read-only in Next.js; cast so tests can simulate envs.
function setNodeEnv(value: string) {
  (process.env as { NODE_ENV?: string }).NODE_ENV = value;
}

afterEach(() => {
  setNodeEnv(originalNodeEnv ?? "test");
});

function getDirective(csp: string, directive: string): string | undefined {
  return csp.match(new RegExp(`${directive} ([^;]+)`))?.[1];
}

describe("buildCsp — script-src hardening", () => {
  it("allows the FOUC inline script by SHA-256 hash, not a nonce", () => {
    setNodeEnv("production");
    const csp = buildCsp(false);
    const scriptSrc = getDirective(csp, "script-src");

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(FOUC_THEME_SCRIPT_HASH);
    // The nonce flow is gone — cached/static pages must not depend on it.
    expect(scriptSrc).not.toContain("'nonce-");
    expect(scriptSrc).not.toContain("'strict-dynamic'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("keeps 'unsafe-inline' and 'unsafe-eval' in development script-src", () => {
    setNodeEnv("development");
    const csp = buildCsp(false);
    const scriptSrc = getDirective(csp, "script-src");

    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
  });

  it("still allows 'self' and the FOUC hash in development", () => {
    setNodeEnv("development");
    const csp = buildCsp(false);
    const scriptSrc = getDirective(csp, "script-src");

    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).toContain(FOUC_THEME_SCRIPT_HASH);
  });
});

describe("buildCsp — frame-ancestors", () => {
  it("denies framing for normal pages and allows it for widgets", () => {
    setNodeEnv("production");
    expect(buildCsp(false)).toContain("frame-ancestors 'none'");
    expect(buildCsp(true)).toContain("frame-ancestors *");
  });
});

describe("buildCsp — Workstream 3 whitelist (CI-enforced)", () => {
  // Issue #1096 requires the deployed policy to match the whitelist on every
  // page; these assertions pin that contract in CI via the jest suite.
  beforeEach(() => setNodeEnv("production"));

  it("enforces object-src 'none' and base-uri 'self'", () => {
    const csp = buildCsp(false);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("never allows unsafe-eval in production", () => {
    expect(buildCsp(false)).not.toContain("unsafe-eval");
    expect(buildCsp(true)).not.toContain("unsafe-eval");
  });

  it("keeps frame-ancestors 'none' for the app (widgets excluded)", () => {
    expect(buildCsp(false)).toContain("frame-ancestors 'none'");
  });

  it("allows Stellar hosts in script-src and connect-src", () => {
    const csp = buildCsp(false);
    expect(getDirective(csp, "script-src")).toContain("'self'");
    expect(getDirective(csp, "connect-src")).toContain(
      "https://horizon-testnet.stellar.org",
    );
  });

  it("does not leak unsafe-inline into production script-src", () => {
    const scriptSrc = getDirective(buildCsp(false), "script-src") ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });
});

describe("buildTrustedTypesReportOnlyCsp — Workstream 3", () => {
  it("requires Trusted Types for script and trusts the dompurify policy", () => {
    const policy = buildTrustedTypesReportOnlyCsp();
    expect(policy).toContain("require-trusted-types-for 'script'");
    expect(policy).toContain("trusted-types dompurify");
    expect(policy).toContain("report-uri /api/csp-report");
    expect(policy).toContain("report-to csp-endpoint");
  });
});

describe("buildCsp — reporting", () => {
  it("uses report-to alongside the legacy report-uri directive", () => {
    setNodeEnv("production");
    const csp = buildCsp(false);

    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });
});

describe("middleware() — deployed response headers (issue #1096, WS3)", () => {
  it("stamps CSP + Trusted Types report-only + Reporting-Endpoints on HTML responses", () => {
    setNodeEnv("production");
    // Re-point the mocked NextResponse.next() at a response stub so the
    // middleware can stamp headers on it, then assert the deployed output.
    const { NextResponse } = require("next/server") as {
      NextResponse: { next: jest.Mock };
    };
    const headers = new Map<string, string>();
    const fakeResponse = {
      headers: {
        set: (key: string, value: string) => {
          headers.set(key.toLowerCase(), value);
        },
      },
      getHeaders: () => Object.fromEntries(headers),
    };
    NextResponse.next.mockReturnValue(fakeResponse);

    const req = { nextUrl: { pathname: "/projects/e2e-amazon-reforestation" } } as never;
    const res = middleware(req);
    const sent = (res as unknown as { getHeaders: () => Record<string, string> }).getHeaders();

    // The main CSP carries the whole whitelist.
    const csp = sent["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("report-to csp-endpoint");
    // Dev-only tokens never leak into the production script-src (unsafe-inline
    // remains allowed for style-src, which is a deliberate non-blocking choice).
    const scriptSrc = getDirective(csp, "script-src") ?? "";
    expect(scriptSrc).not.toContain("unsafe-eval");
    expect(scriptSrc).not.toContain("unsafe-inline");

    // Trusted Types is enforced report-only.
    const reportOnly = sent["content-security-policy-report-only"] ?? "";
    expect(reportOnly).toContain("require-trusted-types-for 'script'");
    expect(reportOnly).toContain("trusted-types dompurify");

    // The named reporting endpoint referenced by `report-to` is registered.
    expect(sent["reporting-endpoints"]).toContain('csp-endpoint="/api/csp-report"');
  });
});
