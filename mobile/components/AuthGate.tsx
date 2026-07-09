/**
 * components/AuthGate.tsx
 *
 * Wrapper around sensitive screens (donate/[id], recurring, scan) that
 * requires the AuthProvider to be in the `unlocked` state before
 * rendering children.
 *
 * State-aware fallback UI:
 *   - state === 'unlocked'    → render children
 *   - state === 'locked'      → "Unlock to continue" + Unlock button
 *   - state === 'cleared'     → "Set up IndigoPay" + Connect wallet CTA
 *                                (no session exists; the unlock
 *                                button would dead-end)
 *   - state === 'hydrating'   → spinner
 *
 * The 'cleared' state fallback is critical: a user with no stored
 * session has nothing to unlock, and tapping the Unlock button would
 * silently fail (unlock() returns false). We render the CTA as a
 * labelled button so the path-forward is explicit. Wiring the actual
 * onboarding flow is Phase 2.
 */
import React, { type ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useAuth, type AuthState } from '../providers/AuthProvider';

export interface AuthGateProps {
  children: ReactNode;
  /** Heading shown on the locked fallback. Default: "This screen is locked". */
  promptTitle?: string;
  /** Body copy shown under the heading. */
  promptBody?: string;
}

export function AuthGate({
  children,
  promptTitle = 'Unlock to continue',
  promptBody = 'IndigoPay requires a quick biometric check before showing this screen.',
}: AuthGateProps) {
  const { isAuthenticated, isUnlocking, unlock, state } = useAuth();

  if (state === 'unlocked' && isAuthenticated) return <>{children}</>;

  return (
    <View
      style={styles.container}
      accessibilityRole="summary"
      accessibilityLiveRegion="polite"
    >
      <FallbackContent
        state={state}
        promptTitle={promptTitle}
        promptBody={promptBody}
        isUnlocking={isUnlocking}
        onUnlock={unlock}
      />
    </View>
  );
}

interface FallbackContentProps {
  state: AuthState;
  promptTitle: string;
  promptBody: string;
  isUnlocking: boolean;
  onUnlock: () => Promise<boolean>;
}

function FallbackContent({
  state,
  promptTitle,
  promptBody,
  isUnlocking,
  onUnlock,
}: FallbackContentProps) {
  if (state === 'hydrating') {
    return (
      <>
        <ActivityIndicator color="#e8f1ea" />
        <Text style={styles.title} accessibilityRole="header">
          Loading…
        </Text>
      </>
    );
  }

  if (state === 'cleared') {
    return (
      <>
        <Text style={styles.icon} accessibilityElementsHidden>
          {'\ud83d\ude4b'}
        </Text>
        <Text style={styles.title} accessibilityRole="header">
          Set up IndigoPay
        </Text>
        <Text style={styles.body}>
          Tap below to connect a Stellar wallet and authorise your first donation.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Connect a Stellar wallet"
          // Phase 2 will replace this with router.push('/connect').
          // For now the press is a deliberately explicit no-op so the
          // screen does not silently pretend to do something it cannot.
          onPress={() => undefined}
          style={({ pressed }) => [
            styles.button,
            pressed ? styles.buttonPressed : null,
          ]}
        >
          <Text style={styles.buttonText}>Connect wallet</Text>
        </Pressable>
      </>
    );
  }

  return (
    <>
      <Text style={styles.icon} accessibilityElementsHidden>
        {'\ud83d\udd12'}
      </Text>
      <Text style={styles.title} accessibilityRole="header">
        {promptTitle}
      </Text>
      <Text style={styles.body}>{promptBody}</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Unlock IndigoPay"
        onPress={() => {
          void onUnlock();
        }}
        disabled={isUnlocking}
        style={({ pressed }) => [
          styles.button,
          isUnlocking ? styles.buttonBusy : null,
          pressed && !isUnlocking ? styles.buttonPressed : null,
        ]}
      >
        {isUnlocking ? (
          <ActivityIndicator color="#ffffff" />
        ) : (
          <Text style={styles.buttonText}>Unlock</Text>
        )}
      </Pressable>
    </>
  );
}

export default AuthGate;

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: 56,
    alignItems: 'center',
    backgroundColor: '#0a1410',
  },
  icon: {
    fontSize: 38,
    marginBottom: 8,
  },
  title: {
    fontSize: 20,
    fontWeight: '700',
    color: '#e8f1ea',
    marginBottom: 8,
    textAlign: 'center',
  },
  body: {
    fontSize: 14,
    color: '#a8b8ac',
    textAlign: 'center',
    marginBottom: 24,
    lineHeight: 20,
  },
  button: {
    backgroundColor: '#227239',
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 160,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonBusy: {
    opacity: 0.7,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonText: {
    fontSize: 15,
    fontWeight: '600',
    color: '#ffffff',
  },
});
