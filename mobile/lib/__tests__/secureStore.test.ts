/**
 * lib/__tests__/secureStore.test.ts
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

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
  secureStore.setCurrentVersion("v1");
  secureStore.setReadVersions(["v1"]);
});

describe("secureStore", () => {
  test("set then get round-trips a value", async () => {
    expect(await secureStore.set("wallet", { id: "abc" })).toBe(true);
    expect(await secureStore.get("wallet")).toEqual({ id: "abc" });

    const stored = ssMock.__peekSecureStoreMock();
    expect(stored.has("@StellarIndigo:v1:wallet")).toBe(true);
    expect(stored.has(secureStore.MANIFEST_KEY)).toBe(true);
  });

  test("get returns null when the key is missing", async () => {
    expect(await secureStore.get("missing")).toBeNull();
  });

  test("get returns null when the stored entry is corrupt", async () => {
    const stored = ssMock.__peekSecureStoreMock();
    stored.set("@StellarIndigo:v1:wallet", "{not-json");

    expect(await secureStore.get("wallet")).toBeNull();
  });

  test("ttlMs expiry makes a fresh stored value unreadable", async () => {
    await secureStore.set("token", "v1");
    const stored = ssMock.__peekSecureStoreMock();
    const raw = stored.get("@StellarIndigo:v1:token")!;
    const parsed = JSON.parse(raw);
    parsed.storedAt = Date.now() - 60_000;
    stored.set("@StellarIndigo:v1:token", JSON.stringify(parsed));

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
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:v1:wallet")).toBe(false);

    mockAuthenticate.mockResolvedValueOnce(true);
    expect(
      await secureStore.set("wallet", { id: "x" }, { requireAuth: true }),
    ).toBe(true);
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:v1:wallet")).toBe(true);
  });

  test("delete is idempotent and respects requireAuth", async () => {
    await secureStore.set("wallet", { id: "x" });
    expect(await secureStore.remove("wallet")).toBe(true);
    expect(await secureStore.remove("wallet")).toBe(true);
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:v1:wallet")).toBe(false);

    await secureStore.set("wallet", { id: "x" });
    mockAuthenticate.mockResolvedValueOnce(false);
    expect(await secureStore.remove("wallet", { requireAuth: true })).toBe(false);
    expect(ssMock.__peekSecureStoreMock().has("@StellarIndigo:v1:wallet")).toBe(true);
  });

  test("has() reports occupancy without parsing JSON", async () => {
    expect(await secureStore.has("wallet")).toBe(false);
    await secureStore.set("wallet", { id: "x" });
    expect(await secureStore.has("wallet")).toBe(true);
  });

  test("quota check throws QuotaExceededError for large payloads on iOS", async () => {
    Platform.OS = "ios";
    const largePayload = "a".repeat(2500);
    await expect(secureStore.set("large", largePayload)).rejects.toThrow(secureStore.QuotaExceededError);
  });

  test("wipeAll() enumerates manifest, deletes keys, and asserts emptiness", async () => {
    await secureStore.set("wallet1", { id: "x" });
    await secureStore.set("wallet2", { id: "y" });
    
    expect(await secureStore.has("wallet1")).toBe(true);
    expect(await secureStore.has("wallet2")).toBe(true);

    await secureStore.wipeAll();

    expect(await secureStore.has("wallet1")).toBe(false);
    expect(await secureStore.has("wallet2")).toBe(false);
    
    const stored = ssMock.__peekSecureStoreMock();
    expect(stored.get(secureStore.MANIFEST_KEY)).toBe("[]");
  });

  test("checkIntegrity() detects missing keys", async () => {
    await secureStore.set("wallet1", { id: "x" });
    const stored = ssMock.__peekSecureStoreMock();
    stored.delete("@StellarIndigo:v1:wallet1"); // Simulate unexpected missing key

    const result = await secureStore.checkIntegrity();
    expect(result.missing).toContain("@StellarIndigo:v1:wallet1");
  });

  test("rotateKey() transitions from old to new version", async () => {
    await secureStore.set("wallet", { id: "x" });
    
    // Simulate updating version
    secureStore.setCurrentVersion("v2");
    secureStore.setReadVersions(["v2", "v1"]);

    // Key exists in v1
    const stored = ssMock.__peekSecureStoreMock();
    expect(stored.has("@StellarIndigo:v1:wallet")).toBe(true);

    // Rotate
    await secureStore.rotateKey("wallet", "v1", "v2");

    // Old is deleted, new is present
    expect(stored.has("@StellarIndigo:v1:wallet")).toBe(false);
    expect(stored.has("@StellarIndigo:v2:wallet")).toBe(true);

    // Dual-read verifies we read the new one (if readVersions is [v2, v1])
    expect(await secureStore.get("wallet")).toEqual({ id: "x" });
  });

  test("rotateKey() with crash injection during rotation (dual-read window)", async () => {
    await secureStore.set("wallet", { id: "x" });
    
    secureStore.setCurrentVersion("v2");
    secureStore.setReadVersions(["v2", "v1"]);

    // Simulate crash after writing new but before deleting old
    const stored = ssMock.__peekSecureStoreMock();
    stored.set("@StellarIndigo:v2:wallet", stored.get("@StellarIndigo:v1:wallet")!);
    
    // Read should still succeed
    expect(await secureStore.get("wallet")).toEqual({ id: "x" });
  });
});
