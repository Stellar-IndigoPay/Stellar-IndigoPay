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
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import { authenticate } from '../hooks/useBiometricAuth';

const KEY_PREFIX = '@StellarIndigo:';

export interface SecureStoreOptions {
  /**
   * When true, every read/write/delete triggers an OS biometric or
   * device-PIN prompt first (using `useBiometricAuth.authenticate`).
   * Use only for the most-sensitive paths (e.g. revealing the active
   * wallet's stored auth nonce). Reading large blobs behind this flag
   * is annoying — see the AuthProvider's in-memory unlock pattern for
   * the recommended UX.
   */
  requireAuth?: boolean;
  /**
   * Maximum age (in ms) of the stored value. Reads of older values
   * resolve to `null` (just like a missing key) so callers can request
   * a fresh value / re-prompt for biometrics.
   * `requireAuth: true` is orthogonal to TTL — both can be on.
   */
  ttlMs?: number;
}

export interface SecureValue<T> {
  value: T;
  storedAt: number;
}

/**
 * Read a value from SecureStore. Returns null on miss, expiry, biometric
 * cancel/error, JSON parse error, or non-string SecureStore payload.
 *
 * The biometric gate is handled by passing `{ requireAuth: true }`; the
 * wrapper invokes `useBiometricAuth.authenticate` from
 * `hooks/useBiometricAuth.ts` lazily so we don't pull React hooks into
 * this module-level wrapper.
 */
export async function get<T = unknown>(
  key: string,
  options: SecureStoreOptions = {}
): Promise<T | null> {
  const fullKey = KEY_PREFIX + key;

  if (options.requireAuth) {
    const success = await authenticate('Confirm identity to reveal secret');
    if (!success) return null;
  }

  try {
    const raw = await SecureStore.getItemAsync(fullKey);
    if (raw === null || raw === undefined) return null;

    const parsed = JSON.parse(raw) as SecureValue<T>;
    if (
      options.ttlMs !== undefined &&
      Date.now() - parsed.storedAt > options.ttlMs
    ) {
      return null;
    }

    return parsed.value;
  } catch (err) {
    // SecureStore returns a Rejection with code -1 on Keychain ACL
    // failure on iOS. JSON.parse throws SyntaxError on corrupted
    // entries. Both are surfaced as null so callers can recover.
    if (__DEV__) console.warn('[secureStore.get] failed', key, err);
    return null;
  }
}

export async function set<T = unknown>(
  key: string,
  value: T,
  options: SecureStoreOptions = {}
): Promise<boolean> {
  const fullKey = KEY_PREFIX + key;

  if (options.requireAuth) {
    const success = await authenticate('Confirm identity to store secret');
    if (!success) return false;
  }

  try {
    const payload: SecureValue<T> = { value, storedAt: Date.now() };
    await SecureStore.setItemAsync(fullKey, JSON.stringify(payload));
    return true;
  } catch (err) {
    // iOS Keychain throws if the value exceeds 2048 bytes; Android
    // throws if EncryptedSharedPreferences is in a bad state. Surface
    // as false so callers can decide whether to bail out.
    if (__DEV__) console.warn('[secureStore.set] failed', key, err);
    return false;
  }
}

/**
 * Delete a single entry. Idempotent (returns true even if the key was
 * missing). Honors `requireAuth: true` with the same biometric prompt
 * as set.
 */
export async function remove(
  key: string,
  options: SecureStoreOptions = {}
): Promise<boolean> {
  const fullKey = KEY_PREFIX + key;

  if (options.requireAuth) {
    const success = await authenticate('Confirm identity to delete secret');
    if (!success) return false;
  }

  try {
    await SecureStore.deleteItemAsync(fullKey);
    return true;
  } catch (err) {
    if (__DEV__) console.warn('[secureStore.remove] failed', key, err);
    return false;
  }
}

/**
 * Cheap existence probe without biometric prompt and without JSON
 * parsing. Returns true iff the slot is occupied, false otherwise.
 */
export async function has(key: string): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(KEY_PREFIX + key);
    return raw !== null && raw !== undefined && raw.length > 0;
  } catch {
    return false;
  }
}

/**
 * Erase every `@StellarIndigo:*` key we own. Used by the AuthProvider
 * `clear()` action when the user signs out / wipes their wallet. We do
 * NOT enumerate via the SecureStore API (Keychain APIs do not expose a
 * list-by-prefix on iOS), so callers are expected to maintain their
 * own allow-list of keys and call `remove()` on each before invoking
 * `wipeAll()`. This helper exists for the "I have no idea what was
 * stored" panic path that the AuthProvider never actually invokes.
 */
export async function wipeAll(): Promise<void> {
  // Intentionally a no-op. Concrete wipe paths should call `remove`
  // for each known key. See AuthProvider.clear() for the canonical
  // implementation.
  if (__DEV__) {
    console.warn(
      '[secureStore.wipeAll] is a no-op by design; AuthProvider.clear() handles the real teardown'
    );
  }
}

/**
 * Exported for tests + advanced consumers that want to inspect the
 * key prefix or run a custom-namespaced read.
 */
export const __internal = {
  KEY_PREFIX,
  isNative: Platform.OS !== 'web',
};
