/**
 * lib/WalletProvider.tsx
 *
 * Centralised wallet React context that wraps Stellar wallet adapters
 * (Freighter, Albedo, xBull, Rabet) into a reactive state machine.
 *
 * Every page (DonateForm, dashboard, admin routes, profiles) uses
 * `useWallet()` to observe connection state, the active public key,
 * and to call `sign()`.
 *
 * The raw adapters live under `lib/wallets/` so non-React callers
 * (workers, scripts, tests) can use them directly. The provider
 * exposes their results as React state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { NETWORK_PASSPHRASE } from "./stellar";
import {
  resolveDefaultWallet,
  getWalletById,
  persistWalletSelection,
  clearWalletSelection,
} from "./wallets";
import type { WalletId } from "./wallets/types";

/**
 * Lifecycle of the wallet connection. Lets callers render explicit
 * loading / error UI without having to derive it from individual flags.
 */
export type WalletConnectionState =
  | "idle" // never tried to connect
  | "detecting" // checking which wallets are installed and restoring session
  | "connecting" // user clicked Connect
  | "connected"
  | "error"; // last attempt failed; see `error`

export interface WalletContextValue {
  state: WalletConnectionState;
  /** Currently active wallet id (e.g. "freighter", "albedo"), null if none. */
  walletId: WalletId | null;
  publicKey: string | null;
  error: string | null;
  /** True once we've successfully detected at least one wallet as installed. */
  isInstalled: boolean;
  /** Connected AND have a non-null public key. */
  isConnected: boolean;
  /** Either actively connecting or detecting on mount. */
  isConnecting: boolean;
  /**
   * Open the wallet connection flow. Pass a specific wallet id to use
   * that wallet; omit to auto-detect and use the best available wallet.
   */
  connect: (walletId?: WalletId) => Promise<void>;
  /** Forget the current public key and clear the wallet preference. */
  disconnect: () => void;
  /** Sign an XDR via the active wallet. */
  sign: (
    xdr: string,
  ) => Promise<{ signedXDR: string | null; error: string | null }>;
  /**
   * Returns true iff `candidate` is set and matches `publicKey` (case-insensitive).
   * Pass `NEXT_PUBLIC_ADMIN_ADDRESS` (or any platform admin) to gate admin-only
   * routes via this helper.
   */
  isAdmin: (candidateAddress: string | null | undefined) => boolean;
}

function noopFallbackContext(): WalletContextValue {
  return {
    state: "idle",
    walletId: null,
    publicKey: null,
    error: null,
    isInstalled: false,
    isConnected: false,
    isConnecting: false,
    connect: async () => {},
    disconnect: () => {},
    sign: async () => ({
      signedXDR: null,
      error: "Wallet provider not ready",
    }),
    isAdmin: () => false,
  };
}

const WalletContext = createContext<WalletContextValue>(noopFallbackContext());

export interface WalletProviderProps {
  children: ReactNode;
}

export function WalletProvider({ children }: WalletProviderProps) {
  const [state, setState] = useState<WalletConnectionState>("idle");
  const [walletId, setWalletId] = useState<WalletId | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(false);

  // On mount: detect which wallets are available and try to silently
  // reconnect a previously authorised session. Cancellable in case the
  // component unmounts mid-flight (React Strict Mode double-mount is
  // safe with this guard).
  useEffect(() => {
    // In E2E tests, __test_publicKey__ is injected via addInitScript.
    // Skip auto-detection so the wallet-connect-button renders and
    // tests can manually trigger the connection flow.
    if (
      typeof window !== "undefined" &&
      (window as unknown as Record<string, unknown>).__test_publicKey__
    )
      return undefined;

    let cancelled = false;
    (async () => {
      setState("detecting");
      try {
        const resolved = await resolveDefaultWallet();
        if (cancelled) return;
        if (resolved) {
          setIsInstalled(true);
          setWalletId(resolved.id);
          try {
            const pk = await resolved.adapter.getPublicKey();
            if (cancelled) return;
            if (pk) {
              setPublicKey(pk);
              setState("connected");
            } else {
              setState("idle");
            }
          } catch {
            // User hasn't authorized yet (or auth expired) — stay idle
            if (!cancelled) setState("idle");
          }
        } else {
          // No wallet installed at all
          if (!cancelled) {
            setIsInstalled(false);
            setState("idle");
          }
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Refs provide truly synchronous guards against double-clicks.
  const connectingRef = useRef(false);

  const connect = useCallback(async (requestedWalletId?: WalletId) => {
    if (connectingRef.current) return;
    connectingRef.current = true;
    setState("connecting");
    setError(null);

    try {
      // Determine which wallet to use
      let adapter;
      let id: WalletId;

      if (requestedWalletId) {
        const found = getWalletById(requestedWalletId);
        if (!found) {
          throw new Error(`Unknown wallet: ${requestedWalletId}`);
        }
        adapter = found;
        id = requestedWalletId;
      } else {
        const resolved = await resolveDefaultWallet();
        if (!resolved) {
          throw new Error(
            "No Stellar wallet detected. Install Freighter, Albedo, xBull, or Rabet to continue.",
          );
        }
        adapter = resolved.adapter;
        id = resolved.id;
      }

      await adapter.connect();
      const pk = await adapter.getPublicKey();
      if (!pk) {
        throw new Error("Wallet did not return a public key.");
      }

      persistWalletSelection(id);
      setWalletId(id);
      setPublicKey(pk);
      setState("connected");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (
        msg.includes("User declined") ||
        msg.includes("rejected") ||
        msg.includes("cancelled")
      ) {
        setError("Connection rejected by user.");
      } else {
        setError(msg);
      }
      setState("error");
    } finally {
      connectingRef.current = false;
    }
  }, []);

  const disconnect = useCallback(() => {
    clearWalletSelection();
    setPublicKey(null);
    setWalletId(null);
    setError(null);
    setState("idle");
  }, []);

  const sign = useCallback(
    async (
      xdr: string,
    ): Promise<{ signedXDR: string | null; error: string | null }> => {
      if (!walletId) {
        return {
          signedXDR: null,
          error: "No wallet connected. Please connect a wallet first.",
        };
      }

      // Test-environment fast path
      if (
        typeof window !== "undefined" &&
        (window as unknown as Record<string, unknown>).__test_publicKey__
      ) {
        return { signedXDR: xdr, error: null };
      }

      const adapter = getWalletById(walletId);
      if (!adapter) {
        return { signedXDR: null, error: `Wallet "${walletId}" not found.` };
      }

      try {
        const network =
          process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
            ? "MAINNET"
            : "TESTNET";
        const signedXDR = await adapter.signTransaction(xdr, {
          networkPassphrase: NETWORK_PASSPHRASE,
          network: network as "TESTNET" | "MAINNET",
        });
        return { signedXDR, error: null };
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("User declined") || msg.includes("rejected")) {
          return { signedXDR: null, error: "Transaction rejected." };
        }
        return { signedXDR: null, error: `Signing failed: ${msg}` };
      }
    },
    [walletId],
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
      walletId,
      publicKey,
      error,
      isInstalled,
      isConnected: state === "connected" && !!publicKey,
      isConnecting: state === "connecting" || state === "detecting",
      connect,
      disconnect,
      sign,
      isAdmin,
    }),
    [state, walletId, publicKey, error, isInstalled, connect, disconnect, sign, isAdmin],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

/** Subscribe to the wallet state machine. */
export function useWallet(): WalletContextValue {
  return useContext(WalletContext);
}
