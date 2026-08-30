/**
 * lib/secureStore.ts
 *
 * Typed wrapper around `expo-secure-store` for the IndigoPay mobile app.
 *
 * Goals
 * - Hide every consumer from the raw `SecureStore.*Async` surface so the
 *   key namespace, error normalisation, and authentication policy are
 *   enforced in one place.
 * - Provide a small, testable API (get/set/delete/has/wipeAll) instead
 *   of dropping the imperative SDK surface into every screen.
 * - Optionally gate reads/writes behind `LocalAuthentication` so
 *   secrets can be bound to "the device owner again proved it was
 *   them" — even if the SecureStore entry was compromised in some
 *   hypothetical attack chain.
 * - Key rotation: supports namespaced keys carrying a version segment and
 *   rotation from old to new version with dual read.
 * - Quota guards: estimate payload size before write, reject exceeding caps.
 *
 * Trade-offs
 * - `requireAuth: true` triggers the OS biometric prompt on EVERY
 *   call. For UX-sensitive paths (e.g. app startup) the AuthProvider
 *   reads once via the unlocked-in-memory pattern instead.
 * - We do not bury non-secret caches (project lists, leaderboards) in
 *   SecureStore. iOS Keychain enforces a 2048-byte cap and Android
 *   EncryptedSharedPreferences has its own quota; the right tool for
 *   those is `utils/cache.ts` (AsyncStorage).
 */
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { authenticate } from "../hooks/useBiometricAuth";

export class QuotaExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuotaExceededError";
  }
}

export const MANIFEST_KEY = "@StellarIndigo:__manifest";

export interface SecureStoreOptions {
  requireAuth?: boolean;
  ttlMs?: number;
}

export interface SecureValue<T> {
  value: T;
  storedAt: number;
}

// Current active version for new writes
let currentVersion = "v1";

// Active read versions in fallback order
let readVersions = ["v1"];

export function setCurrentVersion(version: string) {
  currentVersion = version;
}

export function setReadVersions(versions: string[]) {
  readVersions = versions;
}

function getFullKey(key: string, version: string): string {
  return `@StellarIndigo:${version}:${key}`;
}

async function loadManifest(): Promise<string[]> {
  try {
    const raw = await SecureStore.getItemAsync(MANIFEST_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

async function saveManifest(manifest: string[]): Promise<void> {
  await SecureStore.setItemAsync(MANIFEST_KEY, JSON.stringify(manifest));
}

async function addToManifest(key: string): Promise<void> {
  const manifest = await loadManifest();
  if (!manifest.includes(key)) {
    manifest.push(key);
    await saveManifest(manifest);
  }
}

async function removeFromManifest(key: string): Promise<void> {
  const manifest = await loadManifest();
  const index = manifest.indexOf(key);
  if (index !== -1) {
    manifest.splice(index, 1);
    await saveManifest(manifest);
  }
}

export async function checkIntegrity(): Promise<{ missing: string[]; extra: string[] }> {
  // A simple integrity check to ensure our manifest aligns with reality.
  // Since we can't truly enumerate, we can only verify if manifest keys actually exist.
  const manifest = await loadManifest();
  const missing = [];
  for (const key of manifest) {
    const raw = await SecureStore.getItemAsync(key);
    if (!raw) {
      missing.push(key);
    }
  }
  
  if (missing.length > 0 && __DEV__) {
    console.warn("[secureStore] Startup integrity check found missing keys that were in manifest:", missing);
  }
  return { missing, extra: [] }; // "extra" is impossible to detect without real enumeration
}

export async function get<T = unknown>(
  key: string,
  options: SecureStoreOptions = {},
): Promise<T | null> {
  if (options.requireAuth) {
    const success = await authenticate("Confirm identity to reveal secret");
    if (!success) return null;
  }

  for (const version of readVersions) {
    const fullKey = getFullKey(key, version);
    try {
      const raw = await SecureStore.getItemAsync(fullKey);
      if (raw === null || raw === undefined) continue;

      const parsed = JSON.parse(raw) as SecureValue<T>;
      if (
        options.ttlMs !== undefined &&
        Date.now() - parsed.storedAt > options.ttlMs
      ) {
        continue; // Treat as missing if expired
      }

      return parsed.value;
    } catch (err) {
      if (__DEV__) console.warn("[secureStore.get] failed", fullKey, err);
      // Continue to next version on corruption
    }
  }
  return null;
}

export async function set<T = unknown>(
  key: string,
  value: T,
  options: SecureStoreOptions = {},
): Promise<boolean> {
  if (options.requireAuth) {
    const success = await authenticate("Confirm identity to store secret");
    if (!success) return false;
  }

  const fullKey = getFullKey(key, currentVersion);
  const payload: SecureValue<T> = { value, storedAt: Date.now() };
  const serialized = JSON.stringify(payload);

  // Payload size check
  const cap = Platform.OS === 'ios' ? 2048 : 8192;
  // Estimate byte size. A JS string length is UTF-16 code units.
  // Using encodeURI as a rough approximation of UTF-8 byte length.
  const estimatedSize = encodeURI(serialized).split(/%..|./).length - 1;
  if (estimatedSize > cap) {
    throw new QuotaExceededError(`Payload size ${estimatedSize} exceeds platform cap of ${cap} bytes`);
  }

  try {
    await SecureStore.setItemAsync(fullKey, serialized);
    await addToManifest(fullKey);
    return true;
  } catch (err) {
    if (__DEV__) console.warn("[secureStore.set] failed", key, err);
    return false;
  }
}

export async function remove(
  key: string,
  options: SecureStoreOptions = {},
): Promise<boolean> {
  if (options.requireAuth) {
    const success = await authenticate("Confirm identity to delete secret");
    if (!success) return false;
  }

  let success = true;
  for (const version of readVersions) {
    const fullKey = getFullKey(key, version);
    try {
      await SecureStore.deleteItemAsync(fullKey);
      await removeFromManifest(fullKey);
    } catch (err) {
      if (__DEV__) console.warn("[secureStore.remove] failed", fullKey, err);
      success = false;
    }
  }
  return success;
}

export async function has(key: string): Promise<boolean> {
  for (const version of readVersions) {
    try {
      const raw = await SecureStore.getItemAsync(getFullKey(key, version));
      if (raw !== null && raw !== undefined && raw.length > 0) {
        return true;
      }
    } catch {
      // Ignore
    }
  }
  return false;
}

export async function wipeAll(): Promise<void> {
  const manifest = await loadManifest();
  for (const fullKey of manifest) {
    try {
      await SecureStore.deleteItemAsync(fullKey);
    } catch (err) {
      if (__DEV__) console.warn("[secureStore.wipeAll] failed to delete", fullKey, err);
    }
  }
  await saveManifest([]);

  // Verify emptiness
  const verifyManifest = await loadManifest();
  if (verifyManifest.length > 0) {
    if (__DEV__) console.warn("[secureStore.wipeAll] verification failed, manifest not empty");
  }
  for (const fullKey of manifest) {
    const raw = await SecureStore.getItemAsync(fullKey);
    if (raw) {
       if (__DEV__) console.warn(`[secureStore.wipeAll] verification failed, key ${fullKey} still exists`);
    }
  }
}

export async function rotateKey<T = unknown>(
  key: string,
  oldVersion: string,
  newVersion: string,
  options: SecureStoreOptions = {}
): Promise<boolean> {
  const oldFullKey = getFullKey(key, oldVersion);
  const newFullKey = getFullKey(key, newVersion);

  try {
    const rawOld = await SecureStore.getItemAsync(oldFullKey);
    if (!rawOld) return false;

    const parsed = JSON.parse(rawOld) as SecureValue<T>;
    
    // Store in new version
    const serialized = JSON.stringify(parsed);
    const cap = Platform.OS === 'ios' ? 2048 : 8192;
    const estimatedSize = encodeURI(serialized).split(/%..|./).length - 1;
    if (estimatedSize > cap) {
      throw new QuotaExceededError(`Payload size ${estimatedSize} exceeds platform cap of ${cap} bytes`);
    }

    await SecureStore.setItemAsync(newFullKey, serialized);
    await addToManifest(newFullKey);

    // Delete old
    await SecureStore.deleteItemAsync(oldFullKey);
    await removeFromManifest(oldFullKey);
    return true;
  } catch (err) {
    if (__DEV__) console.warn("[secureStore.rotateKey] failed", key, err);
    return false;
  }
}

export const __internal = {
  KEY_PREFIX: "@StellarIndigo:",
  isNative: Platform.OS !== "web",
};
