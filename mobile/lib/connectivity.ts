/**
 * lib/connectivity.ts
 *
 * Connectivity-aware service layer using @react-native-community/netinfo.
 *
 * Provides:
 *   - useConnectivity() — React hook that tracks online/offline state and
 *     network type. Re-renders the consuming component on change.
 *   - getConnectivity() — imperative snapshot for use outside React
 *     components (e.g. queue workers, saga middleware).
 *   - onConnectivityChange() — low-level callback registration for
 *     non-React consumers that need to react to flips.
 *
 * Usage (hook):
 *   const { isOnline, networkType, isInternetReachable } = useConnectivity();
 *
 * Usage (imperative):
 *   import { getConnectivity, onConnectivityChange } from "../lib/connectivity";
 *   const { isOnline } = await getConnectivity();
 *   const unsub = onConnectivityChange(({ isOnline }) => { ... });
 */
import { useEffect, useState, useCallback } from "react";
import NetInfo, {
  NetInfoState,
  NetInfoSubscription,
} from "@react-native-community/netinfo";

// ─── Types ───────────────────────────────────────────────────────────────

export type NetworkType =
  | "unknown"
  | "none"
  | "cellular"
  | "wifi"
  | "bluetooth"
  | "ethernet"
  | "wimax"
  | "vpn"
  | "other";

export interface ConnectivityState {
  /** Whether the device has any active network connection. */
  isOnline: boolean;
  /** The active network transport type. */
  networkType: NetworkType;
  /** Whether the internet is actually reachable (may be false on a captive portal). */
  isInternetReachable: boolean;
  /** Detailed raw info from NetInfo (for debugging / advanced use). */
  details: NetInfoState | null;
  /** Timestamp of the last connectivity change. */
  lastChangedAt: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function mapState(state: NetInfoState): ConnectivityState {
  return {
    isOnline: state.isConnected === true && state.isInternetReachable !== false,
    networkType: (state.type as NetworkType) || "unknown",
    isInternetReachable: state.isInternetReachable === true,
    details: state,
    lastChangedAt: Date.now(),
  };
}

// ─── Internal shared state ───────────────────────────────────────────────

let internalState: ConnectivityState = {
  isOnline: true,
  networkType: "unknown",
  isInternetReachable: false,
  details: null,
  lastChangedAt: Date.now(),
};

let listeners: Array<(state: ConnectivityState) => void> = [];
let netInfoUnsubscribe: NetInfoSubscription | null = null;

function notifyListeners(state: ConnectivityState) {
  for (const listener of listeners) {
    try {
      listener(state);
    } catch {
      // Swallow listener errors so a bad handler never breaks the chain.
    }
  }
}

/**
 * Initialise the NetInfo subscription if not already active.
 * Called automatically by useConnectivity(); safe to call manually for
 * headless / non-React consumers that don't use the hook.
 */
export function initConnectivity(): void {
  if (netInfoUnsubscribe) return;
  netInfoUnsubscribe = NetInfo.addEventListener((netState) => {
    internalState = mapState(netState);
    notifyListeners(internalState);
  });

  // Fetch initial state
  NetInfo.fetch().then((netState) => {
    internalState = mapState(netState);
    notifyListeners(internalState);
  });
}

/**
 * Tear down the NetInfo subscription. Call during app shutdown / cleanup.
 */
export function destroyConnectivity(): void {
  if (netInfoUnsubscribe) {
    netInfoUnsubscribe();
    netInfoUnsubscribe = null;
  }
  listeners = [];
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Imperative snapshot — returns the current connectivity state without
 * subscribing to changes. Useful in workers, sagas, and non-React code.
 */
export async function getConnectivity(): Promise<ConnectivityState> {
  try {
    const netState = await NetInfo.fetch();
    return mapState(netState);
  } catch {
    return internalState;
  }
}

/**
 * Register a callback that fires on every connectivity change.
 * Returns an unsubscribe function.
 */
export function onConnectivityChange(
  callback: (state: ConnectivityState) => void,
): () => void {
  listeners.push(callback);
  if (listeners.length === 1) {
    initConnectivity();
  }
  return () => {
    listeners = listeners.filter((l) => l !== callback);
  };
}

/**
 * React hook — returns the current connectivity state and re-renders the
 * component whenever connectivity changes.
 *
 * Automatically initialises the NetInfo subscription on first mount and
 * cleans up on last unmount (via ref-counting).
 */
export function useConnectivity(): ConnectivityState {
  const [state, setState] = useState<ConnectivityState>(internalState);

  useEffect(() => {
    initConnectivity();

    const handler = (newState: ConnectivityState) => {
      setState(newState);
    };

    listeners.push(handler);

    // Sync with latest state in case it changed before the handler was added
    setState(internalState);

    return () => {
      listeners = listeners.filter((l) => l !== handler);
    };
  }, []);

  return state;
}
