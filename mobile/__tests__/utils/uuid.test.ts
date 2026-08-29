/**
 * __tests__/utils/uuid.test.ts
 *
 * Unit tests for the client-generated UUID helper used for donation
 * idempotency keys. Every value must satisfy the backend's
 * `Idempotency-Key` validation (RFC 4122 v4 format) and must be unique
 * across calls so retries never accidentally collide.
 */
import { safeRandomUUID, UUID_V4_RE } from "../../utils/uuid";

describe("safeRandomUUID", () => {
  test("returns a UUID v4 matching the backend contract", () => {
    const key = safeRandomUUID();
    expect(UUID_V4_RE.test(key)).toBe(true);
    // Version nibble is 4, variant nibble is one of 8/9/a/b.
    expect(key[14]).toBe("4");
    expect("89ab".includes(key[19])).toBe(true);
  });

  test("generates unique values across many calls", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(safeRandomUUID());
    }
    expect(seen.size).toBe(1000);
  });

  test("falls back to Math.random when crypto.randomUUID is unavailable", () => {
    const originalCrypto = (globalThis as { crypto?: unknown }).crypto;
    // Delete the crypto global so the Math.random fallback path is exercised.
    delete (globalThis as { crypto?: unknown }).crypto;

    try {
      const key = safeRandomUUID();
      expect(UUID_V4_RE.test(key)).toBe(true);
    } finally {
      (globalThis as { crypto?: unknown }).crypto = originalCrypto;
    }
  });

  test("UUID_V4_RE accepts lowercase and uppercase hex", () => {
    expect(UUID_V4_RE.test("123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(UUID_V4_RE.test("123E4567-E89B-42D3-A456-426614174000")).toBe(true);
    expect(UUID_V4_RE.test("not-a-uuid")).toBe(false);
    expect(UUID_V4_RE.test("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
  });
});
