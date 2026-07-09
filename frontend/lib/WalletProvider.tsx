/**
 * lib/WalletProvider.tsx
 *
 * Centralised wallet React context that wraps the imperative Freighter
 * helpers in `lib/wallet.ts` into a reactive state machine.
 *
 * Why: every page (DonateForm, dashboard, admin routes, profiles) needs to
 * know whether the visitor is connected, what their public key is, and how
 * to call sign(). Previously each page called `connectWallet()` itself
 * and passed the resulting `publicKey` string down through props. This
 * provider makes that state globally observable via `useWallet()`.
 *
 * The raw Freighter helpers remain in `lib/wallet.ts` so non-React callers
 * (workers, scripts, tests) can use them directly. The provider simply
 * exposes their results as React state.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  isFreighterInstalled,
  connectWallet,
  getConnectedPublicKey,
  signTransactionWithWallet,
} from "./wallet";

/**
 * Lifecycle of the wallet connection. Lets callers render explicit
 * loading / error UI without having to derive it from individual flags.
 */
export type WalletConnectionState =
  | "idle" // never tried to connect
  | "detecting" // checking if Freighter is installed and restoring session
  | "connecting" // user clicked Connect
  | "connected"
  | "error"; // last attempt failed; see `error`

export interface WalletContextValue {
  state: WalletConnectionState;
  publicKey: string | null;
  error: string | null;
  /** True once we've successfully detected Freighter as installed. */
  isInstalled: boolean;
  /** Connected AND have a non-null public key. */
  isConnected: boolean;
  /** Either actively connecting or detecting on mount. */
  isConnecting: boolean;
  /** Imperatively open the Freighter permission dialog. */
  connect: () => Promise<void>;
  /** Forget the current public key (Freighter stays authorised separately). */
  disconnect: () => void;
  /** Sign an XDR via Freighter; same return shape as `signTransactionWithWallet`. */
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
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isInstalled, setIsInstalled] = useState<boolean>(false);

  // On mount: detect Freighter and try to silently reconnect a previously
  // authorised public key. Cancellable in case the component unmounts
  // mid-flight (React Strict Mode double-mount is safe with this guard).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setState("detecting");
      try {
        const installed = await isFreighterInstalled();
        if (cancelled) return;
        setIsInstalled(installed);
        if (!installed) {
          setState("idle");
          return;
        }
        const pk = await getConnectedPublicKey();
        if (cancelled) return;
        if (pk) {
          setPublicKey(pk);
          setState("connected");
        } else {
          setState("idle");
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

  const connect = useCallback(async () => {
    // Guard against rapid double-clicks that would race two parallel
    // `connectWallet()` awaits and stomp on each other's state writes.
    // We use a state-updater form so the check sees the freshest value
    // without forcing `connect` to depend on closed-over `state`.
    let alreadyInFlight = false;
    setState((current) => {
      if (current === "connecting") {
        alreadyInFlight = true;
        return current;
      }
      return "connecting";
    });
    if (alreadyInFlight) return;

    setError(null);
    const { publicKey: pk, error: err } = await connectWallet();
    if (err) {
      setError(err);
      setState("error");
      return;
    }
    setPublicKey(pk);
    setState(pk ? "connected" : "idle");
  }, []);

  const disconnect = useCallback(() => {
    setPublicKey(null);
    setError(null);
    setState("idle");
  }, []);

  const sign = useCallback(
    async (xdr: string) => signTransactionWithWallet(xdr),
    [],
  );

  const isAdmin = useCallback(
    (candidateAddress: string | null | undefined) => {
      if (!candidateAddress || !publicKey) return false;
      return (
        publicKey.toUpperCase() === candidateAddress.toUpperCase()
      );
    },
    [publicKey],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      state,
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
    [state, publicKey, error, isInstalled, connect, disconnect, sign, isAdmin],
  );

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

/** Subscribe to the wallet state machine. */
export function useWallet(): WalletContextValue {
  return useContext(WalletContext);
}
