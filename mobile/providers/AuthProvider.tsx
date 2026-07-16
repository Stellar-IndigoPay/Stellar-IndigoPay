/**
 * providers/AuthProvider.tsx
 *
 * React context that owns the wallet session for the IndigoPay mobile
 * app. The session itself is a small JSON blob (`WalletSession`) stored
 * in `expo-secure-store` so it survives reboots; the boundary between
 * "stored" and "in-memory" is enforced by the provider's `unlock()` /
 * `lock()` actions.
 *
 * Why
 * - Freighter Mobile holds the actual private keys and signs via a deep
 *   link scheme. This app does NOT see the private key. The
 *   `WalletSession` is therefore a thin record: which public key the
 *   user connected with, which Stellar network they were on, and an
 *   opaque signed nonce the backend can verify.
 * - We auto-lock when the app goes to background for more than 60s
 *   (industry standard for fintech). Re-entering the foreground
 *   requires a biometric/PIN unlock before the in-memory session is
 *   restored.
 *
 * UX contract
 * - On cold launch: `isAuthenticated` starts false. If a stored session
 *   exists, `unlock()` is required to make the in-memory copy
 *   available; otherwise the public-tap experience (home, leaderboard)
 *   still renders via the surrounding AuthGate fall-through.
 * - On warm background: `AppState === 'background'` for >60s → lock.
 *   Quick switches (e.g. copy address from password manager) preserve
 *   the session.
 */
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import * as secureStore from "../lib/secureStore";
import { authenticate } from "../hooks/useBiometricAuth";
import { deleteSecretKey } from "../lib/wallet/sdk";

const SESSION_KEY = "wallet_session";
const AUTO_LOCK_BACKGROUND_MS = 60_000;

export interface WalletSession {
  /** Stellar Ed25519 public key (G…). */
  publicKey: string;
  /** 'PUBLIC' or 'TESTNET' — matches stellar-sdk Network enum string. */
  network: "PUBLIC" | "TESTNET";
  /** Opaque signed nonce the backend can verify on auth refresh. */
  authNonce: string;
  /** Epoch ms when the user unlocked on this device. */
  lastLoginAt: number;
}

export type AuthState = "hydrating" | "locked" | "unlocked" | "cleared";

export interface AuthContextValue {
  state: AuthState;
  /** True only when state === 'unlocked'. */
  isAuthenticated: boolean;
  /** True only while the unlock prompt is open. */
  isUnlocking: boolean;
  /** Current in-memory session. Read-only; do NOT mutate from callers. */
  session: WalletSession | null;
  /**
   * Prompt the user to unlock. Resolves true on success. No-op if
   * `state === 'unlocked'` already, but still resolves true.
   */
  unlock: () => Promise<boolean>;
  /** Force-lock without clearing stored data. */
  lock: () => void;
  /** Wipe in-memory + stored session. Used on sign-out / wallet switch. */
  clear: () => Promise<void>;
  /** Persist a freshly-authenticated session to SecureStore. */
  storeSession: (session: WalletSession) => Promise<boolean>;
}

const noopContext: AuthContextValue = {
  state: "locked",
  isAuthenticated: false,
  isUnlocking: false,
  session: null,
  unlock: async () => false,
  lock: () => undefined,
  clear: async () => undefined,
  storeSession: async () => false,
};

const AuthContext = createContext<AuthContextValue>(noopContext);

export interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [state, setState] = useState<AuthState>("hydrating");
  const [session, setSession] = useState<WalletSession | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);
  const backgroundedAtRef = useRef<number | null>(null);
  const mountedRef = useRef(true);

  // ---- Hydration on mount: surface "locked" if a stored session exists;
  //                            "cleared" if no session at all. We do
  //                            NOT auto-unlock — that requires explicit
  //                            user intent so an attacker who picks up an
  //                            already-unlocked phone cannot bypass.
  useEffect(() => {
    mountedRef.current = true;
    (async () => {
      const stored = await secureStore.get<WalletSession>(SESSION_KEY);
      if (!mountedRef.current) return;
      if (stored === null) {
        setState("cleared");
        setSession(null);
      } else {
        setState("locked");
        setSession(null); // do not expose until unlock()
      }
    })();
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // ---- Auto-lock on AppState background >= 60s.
  useEffect(() => {
    function onChange(next: AppStateStatus) {
      if (next === "background" || next === "inactive") {
        backgroundedAtRef.current = Date.now();
      } else if (next === "active") {
        const since = backgroundedAtRef.current;
        backgroundedAtRef.current = null;
        if (since !== null && Date.now() - since >= AUTO_LOCK_BACKGROUND_MS) {
          setState((prev) => (prev === "unlocked" ? "locked" : prev));
          setSession(null);
        }
      }
    }
    const sub = AppState.addEventListener("change", onChange);
    return () => sub.remove();
  }, []);

  // ---- Public actions ------------------------------------------------

  const unlock = useCallback(async (): Promise<boolean> => {
    if (state === "unlocked") return true;
    if (state === "cleared") return false; // nothing to unlock
    if (state === "hydrating") return false; // caller should retry

    if (!mountedRef.current) return false;
    setIsUnlocking(true);
    try {
      const success = await authenticate("Unlock IndigoPay to continue");
      if (!mountedRef.current) return false;
      if (!success) return false;

      const stored = await secureStore.get<WalletSession>(SESSION_KEY);
      if (!mountedRef.current) return false;
      if (stored === null) {
        setState("cleared");
        setSession(null);
        return false;
      }
      setSession(stored);
      setState("unlocked");
      return true;
    } finally {
      if (mountedRef.current) setIsUnlocking(false);
    }
  }, [state, authenticate]);

  const lock = useCallback(() => {
    setState((prev) => (prev === "unlocked" ? "locked" : prev));
    setSession(null);
  }, []);

  const clear = useCallback(async () => {
    // Wipe the secret key from SecureStore (best-effort, non-fatal)
    try { await deleteSecretKey(); } catch { /* key may not exist */ }
    await secureStore.remove(SESSION_KEY);
    if (!mountedRef.current) return;
    setSession(null);
    setState("cleared");
  }, []);

  const storeSession = useCallback(
    async (next: WalletSession): Promise<boolean> => {
      const ok = await secureStore.set(SESSION_KEY, next);
      if (!ok) return false;
      if (!mountedRef.current) return false;
      setSession(next);
      setState("unlocked");
      return true;
    },
    [],
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      state,
      isAuthenticated: state === "unlocked",
      isUnlocking,
      session,
      unlock,
      lock,
      clear,
      storeSession,
    }),
    [state, isUnlocking, session, unlock, lock, clear, storeSession],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Subscribe to the AuthProvider state. Returns the no-op fallback
 *   when used outside the provider so legacy screens do not crash. */
export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
