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

import { buildCsp } from "@/middleware";
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

describe("buildCsp — reporting", () => {
  it("uses report-to alongside the legacy report-uri directive", () => {
    setNodeEnv("production");
    const csp = buildCsp(false);

    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });
});
