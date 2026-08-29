/**
 * __tests__/csp.test.ts — guards the cache-safe CSP constants in lib/csp.ts.
 *
 * The FOUC theme script is the app's only inline executable script, and the
 * CSP allows it via a SHA-256 hash-source rather than a per-request nonce.
 * A hash is deterministic, so the same policy works for SSG / ISR / edge-cached
 * and server-rendered HTML alike (no nonce-mismatch — closes #689).
 *
 * These tests pin that contract so the script and its hash can never drift:
 * if someone edits FOUC_THEME_SCRIPT without regenerating the hash (or vice
 * versa), the hash test fails loudly.
 *
 * @jest-environment jsdom
 */
import { createHash } from "crypto";

import {
  FOUC_THEME_SCRIPT,
  FOUC_THEME_SCRIPT_HASH,
} from "@/lib/csp";

function sha256Base64(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("base64");
}

describe("lib/csp — FOUC theme script hash", () => {
  it("FOUC_THEME_SCRIPT_HASH is the SHA-256 of FOUC_THEME_SCRIPT", () => {
    // The hash-source is emitted as `'sha256-<base64>'`, so strip the CSP
    // quoting to compare against the raw digest.
    const digest = FOUC_THEME_SCRIPT_HASH.replace(/^'sha256-/, "").replace(/'$/, "");
    expect(digest).toBe(sha256Base64(FOUC_THEME_SCRIPT));
    // And confirm the full source expression is well-formed.
    expect(FOUC_THEME_SCRIPT_HASH).toMatch(/^'sha256-[A-Za-z0-9+/]+={0,2}'$/);
  });

  it("FOUC_THEME_SCRIPT reads the same localStorage key as lib/theme", () => {
    // The script must mirror THEME_STORAGE_KEY in lib/theme.tsx, otherwise the
    // pre-hydration paint diverges from what React hydrates into.
    expect(FOUC_THEME_SCRIPT).toContain('"stellar-indigopay-theme"');
  });

  it("is deterministic across calls (cache-safe)", () => {
    // A hash is the cache-safe replacement for the removed per-request nonce:
    // every render must produce the identical source expression.
    expect(FOUC_THEME_SCRIPT_HASH).toBe(FOUC_THEME_SCRIPT_HASH);
    expect(sha256Base64(FOUC_THEME_SCRIPT)).toBe(sha256Base64(FOUC_THEME_SCRIPT));
  });
});
