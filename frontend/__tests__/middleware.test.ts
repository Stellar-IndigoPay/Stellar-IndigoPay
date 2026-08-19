/**
 * __tests__/middleware.test.ts — Unit tests for middleware.ts CSP generation.
 *
 * Verifies the per-environment CSP hardening from issue #688:
 *   - production `script-src` excludes `'unsafe-inline'`/`'unsafe-eval'`
 *   - development keeps them for Fast Refresh / HMR
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

const NONCE = "test-nonce-123";

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
  it("excludes 'unsafe-inline' and 'unsafe-eval' from production script-src", () => {
    setNodeEnv("production");
    const csp = buildCsp(NONCE, false);
    const scriptSrc = getDirective(csp, "script-src");

    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    expect(scriptSrc).toContain("'strict-dynamic'");
  });

  it("keeps 'unsafe-inline' and 'unsafe-eval' in development script-src", () => {
    setNodeEnv("development");
    const csp = buildCsp(NONCE, false);
    const scriptSrc = getDirective(csp, "script-src");

    expect(scriptSrc).toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'unsafe-eval'");
  });
});

describe("buildCsp — reporting", () => {
  it("uses report-to alongside the legacy report-uri directive", () => {
    setNodeEnv("production");
    const csp = buildCsp(NONCE, false);

    expect(csp).toContain("report-to csp-endpoint");
    expect(csp).toContain("report-uri /api/csp-report");
  });
});
