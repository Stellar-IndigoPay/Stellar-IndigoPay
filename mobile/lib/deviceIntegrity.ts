/**
 * lib/deviceIntegrity.ts
 *
 * Jailbreak/root detection + policy enforcement for the IndigoPay mobile
 * app. This is the single "device-integrity check" module referenced by
 * issue #693.
 *
 * Why
 * - Biometric auth and SecureStore only protect secrets on a trusted OS.
 *   On a rooted/jailbroken device the secure enclave, iOS Keychain, and
 *   Android EncryptedSharedPreferences can all be bypassed, so biometric
 *   gates alone are not enough — we must refuse (or at minimum warn about)
 *   sensitive flows on compromised devices.
 *
 * Design
 * - The detector is injectable (`setIntegrityDetector`) so unit tests can
 *   drive "compromised" vs "clean" without any native module. Production
 *   uses expo-device's `isRootedExperimentalAsync()`.
 * - The policy is read from `EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY` at call
 *   time, so EAS builds can ship `"block"` while simulators / dev builds
 *   can use `"off"`. Valid values are `"off" | "warn" | "block"`; the
 *   default is `"block"`.
 * - The check is best-effort: `isRootedExperimentalAsync` is documented as
 *   experimental and can be bypassed (xCon on iOS, root-hiding on Android).
 *   It is one layer of defence, not a replacement for remote attestation
 *   (which is explicitly out of scope for this issue).
 */
import * as Device from "expo-device";
import { Platform } from "react-native";

// ─── Types ────────────────────────────────────────────────────────────────

/** Configured reaction to a compromised device. */
export type IntegrityPolicy = "off" | "warn" | "block";

/** What the caller should do with the result. */
export type IntegrityAction = "allow" | "warn" | "block";

/** Raw verdict from a detector. */
export interface DeviceIntegrityResult {
  /** True when the device shows signs of jailbreak/root compromise. */
  isCompromised: boolean;
  /** Human-readable signals that produced the verdict (empty when clean). */
  reasons: string[];
  /**
   * False when the check could not run at all (web, native module
   * missing/threw). A `supported: false` result is treated as clean so
   * the app does not brick itself when the detector is unavailable.
   */
  supported: boolean;
}

/** Resolved policy decision produced by `evaluateIntegrityPolicy`. */
export interface IntegrityDecision {
  action: IntegrityAction;
  policy: IntegrityPolicy;
  isCompromised: boolean;
  result: DeviceIntegrityResult;
}

/** Injectable async check. Returns a `DeviceIntegrityResult`. */
export type IntegrityDetector = () => Promise<DeviceIntegrityResult>;

// ─── Configuration ────────────────────────────────────────────────────────

export const DEFAULT_INTEGRITY_POLICY: IntegrityPolicy = "block";

/**
 * Normalise a raw policy string into a valid `IntegrityPolicy`: trim
 * whitespace, lowercase, and fall back to the default for anything that is
 * not one of `off` / `warn` / `block`. Pure and never throws.
 */
export function normalizeIntegrityPolicy(
  raw: string | undefined,
): IntegrityPolicy {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "off" || value === "warn" || value === "block") return value;
  return DEFAULT_INTEGRITY_POLICY;
}

/**
 * Read the active policy. Expo's babel transform inlines `EXPO_PUBLIC_*`
 * variables at build time, but only when they are referenced with static
 * dot notation — a computed lookup (`process.env[KEY]`) is NOT inlined, so
 * native builds would always fall back to the default. Hence the static
 * reference below; `normalizeIntegrityPolicy` is kept pure so the
 * sanitisation/fallback logic stays unit-testable without relying on the
 * transform.
 */
export function getIntegrityPolicy(): IntegrityPolicy {
  return normalizeIntegrityPolicy(
    process.env.EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY,
  );
}

// ─── Detector ─────────────────────────────────────────────────────────────

let activeDetector: IntegrityDetector = defaultDetector;

/** Override the detector (tests + advanced integrations). */
export function setIntegrityDetector(detector: IntegrityDetector): void {
  activeDetector = detector;
}

/** Restore the production (expo-device) detector. */
export function resetIntegrityDetector(): void {
  activeDetector = defaultDetector;
}

/**
 * Production detector backed by expo-device. Returns clean on web and on
 * detector failure (fail-open) so the integrity check can never brick the
 * app; enforcement then rests on the OS-native protections alone.
 */
async function defaultDetector(): Promise<DeviceIntegrityResult> {
  if (Platform.OS === "web") {
    return { isCompromised: false, reasons: [], supported: false };
  }

  try {
    const rooted = await Device.isRootedExperimentalAsync();
    return {
      isCompromised: rooted === true,
      reasons:
        rooted === true
          ? ["expo-device reported a rooted/jailbroken device"]
          : [],
      supported: true,
    };
  } catch (err) {
    if (__DEV__) {
      // eslint-disable-next-line no-console
      console.warn("[deviceIntegrity] check failed", err);
    }
    return { isCompromised: false, reasons: [], supported: false };
  }
}

// ─── Core API ─────────────────────────────────────────────────────────────

/** Run the active detector and return its raw verdict. */
export async function checkDeviceIntegrity(): Promise<DeviceIntegrityResult> {
  return activeDetector();
}

/**
 * Pure policy mapping: compromise verdict + policy → caller action.
 * Never throws.
 */
export function evaluateIntegrityPolicy(
  result: DeviceIntegrityResult,
  policy: IntegrityPolicy = getIntegrityPolicy(),
): IntegrityDecision {
  if (!result.isCompromised) {
    return { action: "allow", policy, isCompromised: false, result };
  }

  if (policy === "off") {
    return { action: "allow", policy, isCompromised: true, result };
  }

  if (policy === "warn") {
    recordWarning(result);
    return { action: "warn", policy, isCompromised: true, result };
  }

  recordWarning(result);
  return { action: "block", policy, isCompromised: true, result };
}

/**
 * Convenience wrapper: run the check, then map it through the active
 * policy. Callers (auth gates) branch on `decision.action`:
 *   - "allow" → proceed
 *   - "warn"  → proceed, but surface `getLastIntegrityWarning()`
 *   - "block" → refuse the sensitive flow
 */
export async function enforceIntegrityPolicy(
  policy: IntegrityPolicy = getIntegrityPolicy(),
): Promise<IntegrityDecision> {
  const result = await checkDeviceIntegrity();
  return evaluateIntegrityPolicy(result, policy);
}

// ─── Warning surfacing ────────────────────────────────────────────────────

let lastWarning: string | null = null;
const warningListeners = new Set<(warning: string) => void>();

function recordWarning(result: DeviceIntegrityResult): void {
  const warning =
    result.reasons[0] ?? "Compromised (rooted/jailbroken) device detected";
  lastWarning = warning;

  if (__DEV__) {
    // eslint-disable-next-line no-console
    console.warn("[deviceIntegrity]", warning);
  }

  for (const listener of warningListeners) {
    try {
      listener(warning);
    } catch {
      // A broken listener must never break policy enforcement.
    }
  }
}

/** Most recent warning emitted by a "warn"/"block" decision, or null. */
export function getLastIntegrityWarning(): string | null {
  return lastWarning;
}

/** Subscribe to integrity warnings. Returns an unsubscribe function. */
export function onIntegrityWarning(
  callback: (warning: string) => void,
): () => void {
  warningListeners.add(callback);
  return () => {
    warningListeners.delete(callback);
  };
}
