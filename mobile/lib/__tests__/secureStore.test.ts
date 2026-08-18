/**
 * lib/__tests__/secureStore.test.ts
 *
 * Unit tests for the `secureStore.ts` wrapper around expo-secure-store.
 *
 * The wrapper is intentionally small so we cover its full surface here:
 *   - get/set round-trip with prefix isolation
 *   - TTL: stale values resolve to null
 *   - requireAuth: biometric prompt must succeed before read/write/delete
 *   - delete is idempotent and respects requireAuth
 *   - JSON parse errors on corrupted entries resolve to null
 */
import * as SecureStore from "expo-secure-store";

// Stub the dynamic import inside secureStore that points at
// `../hooks/useBiometricAuth` so we can pin authenticate behavior
// per test without pulling in the full hook.
jest.mock("../../hooks/useBiometricAuth", () => ({
  authenticate: jest.fn(),
}));

import * as biometricAuth from "../../hooks/useBiometricAuth";
import * as secureStore from "../secureStore";

const mockAuthenticate = biometricAuth.authenticate as jest.MockedFunction<
  typeof biometricAuth.authenticate
>;
const ssMock = SecureStore as unknown as {
  __resetSecureStoreMock: () => void;
  __peekSecureStoreMock: () => Map<string, string>;
};

beforeEach(() => {
  mockAuthenticate.mockReset();
  ssMock.__resetSecureStoreMock();
});

describe("secureStore", () => {
  test("set then get round-trips a value with the @StellarIndigo: prefix", async () => {
    expect(await secureStore.set("wallet", { id: "abc" })).toBe(true);
    expect(await secureStore.get("wallet")).toEqual({ id: "abc" });

    const stored = ssMock.__peekSecureStoreMock();
    expect(stored.has("@StellarIndigo:wallet")).toBe(true);
  });

  test("get returns null when the key is missing", async () => {
    expect(await secureStore.get("missing")).toBeNull();
  });

  test("get returns null when the stored entry is corrupt", async () => {
    // Plant a corrupted JSON entry directly into the mock Map.
    const stored = ssMock.__peekSecureStoreMock();
    stored.set("@StellarIndigo:wallet", "{not-json");

    expect(await secureStore.get("wallet")).toBeNull();
  });

  test("ttlMs expiry makes a fresh stored value unreadable", async () => {
    await secureStore.set("token", "v1");
    // Force the stored timestamp into the past to simulate expiry.
    const stored = ssMock.__peekSecureStoreMock();
    const raw = stored.get("@StellarIndigo:token")!;
    const parsed = JSON.parse(raw);
    parsed.storedAt = Date.now() - 60_000;
    stored.set("@StellarIndigo:token", JSON.stringify(parsed));

    expect(await secureStore.get("token", { ttlMs: 1000 })).toBeNull();
  });

  test("requireAuth true delegates to authenticate before reading", async () => {
    await secureStore.set("wallet", { id: "abc" });
    mockAuthenticate.mockResolvedValueOnce(false);

    expect(await secureStore.get("wallet", { requireAuth: true })).toBeNull();
    expect(mockAuthenticate).toHaveBeenCalledTimes(1);

    mockAuthenticate.mockResolvedValueOnce(true);
    expect(await secureStore.get("wallet", { requireAuth: true })).toEqual({
      id: "abc",
    });
  });

  test("requireAuth true delegates to authenticate before writing", async () => {
    mockAuthenticate.mockResolvedValueOnce(false);
    expect(
      await secureStore.set("wallet", { id: "x" }, { requireAuth: true }),
    ).toBe(false);
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:wallet")).toBe(
      false,
    );

    mockAuthenticate.mockResolvedValueOnce(true);
    expect(
      await secureStore.set("wallet", { id: "x" }, { requireAuth: true }),
    ).toBe(true);
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:wallet")).toBe(
      true,
    );
  });

  test("delete is idempotent and respects requireAuth", async () => {
    await secureStore.set("wallet", { id: "x" });
    expect(await secureStore.remove("wallet")).toBe(true);
    expect(await secureStore.remove("wallet")).toBe(true);
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:wallet")).toBe(
      false,
    );

    await secureStore.set("wallet", { id: "x" });
    mockAuthenticate.mockResolvedValueOnce(false);
    expect(await secureStore.remove("wallet", { requireAuth: true })).toBe(
      false,
    );
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:wallet")).toBe(
      true,
    );
  });

  test("has() reports occupancy without parsing JSON", async () => {
    expect(await secureStore.has("wallet")).toBe(false);
    await secureStore.set("wallet", { id: "x" });
    expect(await secureStore.has("wallet")).toBe(true);
  });

  test("wipeAll() is a documented no-op", async () => {
    await secureStore.set("wallet", { id: "x" });
    await secureStore.wipeAll();
    // wipeAll does not actually erase anything on its own — callers
    // must call remove() per key for each known entry.
    expect(await secureStore.has("wallet")).toBe(true);
  });
});
