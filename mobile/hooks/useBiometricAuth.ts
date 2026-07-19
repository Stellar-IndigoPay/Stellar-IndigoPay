/**
 * hooks/useBiometricAuth.ts
 *
 * Enhanced biometric (Face ID / fingerprint) authentication hook with
 * threshold checking, preference storage via AsyncStorage, and fallback configuration.
 */
import { useState, useEffect } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BIOMETRIC_THRESHOLD_KEY = '@indigopay:biometric_threshold';
const BIOMETRIC_ENABLED_KEY = '@indigopay:biometric_enabled';
const DEFAULT_THRESHOLD_XLM = 50;

export function useBiometricAuth() {
  const [isAvailable, setIsAvailable] = useState(false);
  const [biometricType, setBiometricType] = useState<string | null>(null);
  const [threshold, setThreshold] = useState(DEFAULT_THRESHOLD_XLM);
  const [isEnabled, setIsEnabled] = useState(true);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    checkAvailability();
    loadPreferences();
  }, []);

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

  async function confirmDonation(amount: number): Promise<{ success: boolean; error?: string }> {
    if (!isEnabled || !isAvailable || amount < threshold) {
      return { success: true }; // No confirmation needed
    }

    setIsAuthenticating(true);
    try {
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

  async function setBiometricThreshold(newThreshold: number) {
    setThreshold(newThreshold);
    try {
      await AsyncStorage.setItem(BIOMETRIC_THRESHOLD_KEY, String(newThreshold));
    } catch (err) {
      console.error('Error saving biometric threshold:', err);
    }
  }

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
    confirmDonation,
    setBiometricThreshold,
    setIsEnabled: updateIsEnabled,
  };
}

/**
 * Standalone authenticate helper exported for non-hook consumers
 * (e.g. secureStore.ts) that can't call the React hook directly.
 */
export async function authenticate(reason: string): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: reason,
      fallbackLabel: 'Use device passcode',
    });
    return result.success;
  } catch {
    return false;
  }
}
