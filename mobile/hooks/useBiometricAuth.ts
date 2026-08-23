/**
 * hooks/useBiometricAuth.ts
 *
 * Enhanced biometric (Face ID / fingerprint) authentication hook with
 * threshold checking, preference storage via AsyncStorage, and fallback
 * configuration.
 *
 * Device integrity (issue #693): every biometric gate is additionally
 * guarded by a jailbreak/root check from `lib/deviceIntegrity`. Under the
 * configured `"block"` policy, a compromised device cannot authenticate,
 * reveal stored secrets, or confirm a donation; under `"warn"` the flow
 * proceeds but surfaces a warning.
 */
import { useState, useEffect } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  checkDeviceIntegrity,
  enforceIntegrityPolicy,
  getIntegrityPolicy,
  getLastIntegrityWarning,
  type IntegrityPolicy,
} from '../lib/deviceIntegrity';

const BIOMETRIC_THRESHOLD_KEY = '@indigopay:biometric_threshold';
const BIOMETRIC_ENABLED_KEY = '@indigopay:biometric_enabled';
const DEFAULT_THRESHOLD_XLM = 50;

const COMPROMISED_DEVICE_ERROR = 'Device integrity check failed';

/**
 * Biometric-auth hook: detects hardware/enrolment, manages the
 * per-amount threshold + enabled preference, and gates donation
 * confirmation on the device-integrity policy before prompting.
 */
export function useBiometricAuth() {
  const [isAvailable, setIsAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_XLM);
  const [isEnabled, setIsEnabled] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isDeviceCompromised, setIsDeviceCompromised] = useState(false);
  const [integrityWarning, setIntegrityWarning] = useState<string | null>(null);
  const [integrityPolicy] = useState<IntegrityPolicy>(() => getIntegrityPolicy());

  useEffect(() => {
    checkAvailability();
    loadPreferences();
    refreshIntegrity();
  }, []);

  /** Probe hardware support, enrolment, and the biometric type. */
  async function checkAvailability() {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    setIsAvailable(compatible && enrolled);
    if (compatible) {
      const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
      setBiometricType(
        types.includes(LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION)
          ? 'Face ID' : types.includes(LocalAuthentication.AuthenticationType.FINGERPRINT)
          ? 'Touch ID' : 'Biometric'
      );
    }
  }

  /** Read-only probe used at mount so screens can surface a warning early. */
  async function refreshIntegrity() {
    try {
      const result = await checkDeviceIntegrity();
      setIsDeviceCompromised(result.isCompromised);
      setIntegrityWarning(
        result.isCompromised
          ? (result.reasons[0] ?? 'Compromised (rooted/jailbroken) device detected')
          : null
      );
    } catch {
      // The detector never throws by contract; keep this defensive.
    }
  }

  /** Restore the stored threshold and enabled preference. */
  async function loadPreferences() {
    try {
      const stored = await AsyncStorage.getItem(BIOMETRIC_THRESHOLD_KEY);
      if (stored) setThreshold(Number(stored));
      const enabled = await AsyncStorage.getItem(BIOMETRIC_ENABLED_KEY);
      if (enabled !== null) setIsEnabled(enabled === 'true');
    } catch (err) {
      console.error('Error loading biometric preferences:', err);
    }
  }

  /**
   * Confirm a donation, enforcing the device-integrity policy first:
   * `block` refuses before any prompt, `warn` proceeds but records a
   * warning. Skips the prompt entirely when disabled/unavailable or
   * below the configured threshold.
   */
  async function confirmDonation(amount: number): Promise<{ success: boolean; error?: string }> {
    setIsAuthenticating(true);
    try {
      const decision = await enforceIntegrityPolicy();
      setIsDeviceCompromised(decision.isCompromised);

      if (decision.action === 'block') {
        setIntegrityWarning(getLastIntegrityWarning());
        return { success: false, error: COMPROMISED_DEVICE_ERROR };
      }
      if (decision.action === 'warn') {
        setIntegrityWarning(getLastIntegrityWarning());
      }

      if (!isEnabled || !isAvailable || amount < threshold) {
        return { success: true }; // No confirmation needed
      }

      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: `Confirm donation of ${amount} XLM`,
        fallbackLabel: 'Use device passcode',
        cancelLabel: 'Cancel donation',
      });
      return { success: result.success, error: (result as any).error || undefined };
    } catch (err) {
      return { success: false, error: 'Biometric authentication failed' };
    } finally {
      setIsAuthenticating(false);
    }
  }

  /** Persist the amount threshold above which a prompt is required. */
  async function setBiometricThreshold(newThreshold: number) {
    setThreshold(newThreshold);
    try {
      await AsyncStorage.setItem(BIOMETRIC_THRESHOLD_KEY, String(newThreshold));
    } catch (err) {
      console.error('Error saving biometric threshold:', err);
    }
  }

  /** Persist whether the biometric gate is enabled at all. */
  async function updateIsEnabled(value: boolean) {
    setIsEnabled(value);
    try {
      await AsyncStorage.setItem(BIOMETRIC_ENABLED_KEY, String(value));
    } catch (err) {
      console.error('Error saving biometric enabled status:', err);
    }
  }

  return {
    isAvailable,
    biometricType,
    threshold,
    isEnabled,
    isAuthenticating,
    isDeviceCompromised,
    integrityPolicy,
    integrityWarning,
    confirmDonation,
    setBiometricThreshold,
    setIsEnabled: updateIsEnabled,
  };
}

/**
 * Standalone authenticate helper exported for non-hook consumers
 * (e.g. secureStore.ts) that can't call the React hook directly.
 *
 * Enforces the device-integrity policy before prompting: under the
 * `"block"` policy a compromised device resolves `false` without ever
 * showing the OS biometric prompt.
 */
export async function authenticate(reason: string): Promise<boolean> {
  try {
    const decision = await enforceIntegrityPolicy();
    if (decision.action === 'block') return false;

    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use device passcode',
    });
    return result.success;
  } catch {
    return false;
  }
}
