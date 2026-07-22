/**
 * .storybook/MockWalletProvider.tsx
 *
 * Replaces the real WalletProvider (which depends on Freighter browser
 * extension) with a mock that simulates a connected wallet state.
 *
 * This file is aliased to `@/lib/WalletProvider` via Vite in main.ts so
 * all component imports of `useWallet` / `WalletProvider` resolve here
 * instead of the real Freighter-dependent module.
 */
import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";

export type WalletConnectionState =
  | "idle"
  | "detecting"
  | "connecting"
  | "connected"
  | "error";

export interface WalletContextValue {
  state: WalletConnectionState;
  publicKey: string | null;
  error: string | null;
  isInstalled: boolean;
  isConnected: boolean;
  isConnecting: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  sign: (
    xdr: string,
  ) => Promise<{ signedXDR: string | null; error: string | null }>;
  isAdmin: (candidateAddress: string | null | undefined) => boolean;
}

const MOCK_PUBLIC_KEY =
  "GAMZRJ5EYHRG2KQRA2P4Q3UCXMEDRSJE5H4ML4QJ4SNQ3QFJLKFNCWJ7";

const MockWalletContext = createContext<WalletContextValue>({
  state: "connected",
  publicKey: MOCK_PUBLIC_KEY,
  error: null,
  isInstalled: true,
  isConnected: true,
  isConnecting: false,
  connect: async () => {},
  disconnect: () => {},
  sign: async () => ({ signedXDR: null, error: "Not implemented in mock" }),
  isAdmin: () => false,
});

/**
 * Hook that returns the current mock wallet state. Exported as `useWallet`
 * to match the real WalletProvider's public API so components importing
 * `{ useWallet } from "@/lib/WalletProvider"` work seamlessly.
 */
export function useWallet(): WalletContextValue {
  return useContext(MockWalletContext);
}

/**
 * Mock wallet provider component. Wraps children in a mock wallet context
 * with a simulated connected state (no Freighter dependency).
 * Exported as `WalletProvider` to match the real module's public API.
 */
export function WalletProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WalletConnectionState>("connected");
  const [publicKey, setPublicKey] = useState<string | null>(MOCK_PUBLIC_KEY);
  const [error, setError] = useState<string | null>(null);

  const isConnected = state === "connected" && !!publicKey;
  const isConnecting = state === "connecting" || state === "detecting";

  const connect = useCallback(async () => {
    setState("connecting");
    await new Promise((r) => setTimeout(r, 500));
    setPublicKey(MOCK_PUBLIC_KEY);
    setState("connected");
  }, []);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setState("idle");
  }, []);

  const sign = useCallback(
    async () => ({ signedXDR: null, error: "Not implemented in mock" }),
    [],
  );

  const isAdmin = useCallback(
    (candidateAddress: string | null | undefined) => {
      if (!candidateAddress || !publicKey) return false;
      return publicKey.toUpperCase() === candidateAddress.toUpperCase();
    },
    [publicKey],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      state,
      publicKey,
      error,
      isInstalled: true,
      isConnected,
      isConnecting,
      connect,
      disconnect,
      sign,
      isAdmin,
    }),
    [state, publicKey, error, isConnected, isConnecting, connect, disconnect, sign, isAdmin],
  );

  return (
    <MockWalletContext.Provider value={value}>
      {children}
    </MockWalletContext.Provider>
  );
}
