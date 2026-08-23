/**
 * utils/uuid.ts
 *
 * Safe client-side random UUID generator for React Native, mirroring the
 * web layer's `frontend/utils/uuid.ts`. Produces RFC 4122 version-4 UUIDs
 * so the backend's `Idempotency-Key` middleware (which validates
 * `^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
 * accepts every value we generate.
 *
 * Hermes exposes `crypto.randomUUID()` on newer runtimes, but not on every
 * device/bundler combination, so we fall back to a Math.random-based v4
 * generator identical in spirit to the browser fallback.
 */
export function safeRandomUUID(): string {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;

  if (globalCrypto && typeof globalCrypto.randomUUID === "function") {
    try {
      return globalCrypto.randomUUID();
    } catch {
      // Fall through to the deterministic-format fallback below.
    }
  }

  // Version 4 (`4xxx`) + variant 10xx (`8|9|a|b`) guarantees the backend's
  // UUID regex accepts the value regardless of runtime crypto support.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * Strict UUID v4 regex. Tighter than the backend's `UUID_RE` (which accepts
 * versions 1-5) — safe because `safeRandomUUID()` always emits v4 — and used
 * by tests to assert every generated key is a well-formed v4 UUID.
 */
export const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
