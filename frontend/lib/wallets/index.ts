/**
 * lib/wallets/index.ts
 *
 * Wallet registry — discovers which Stellar browser-extension wallets
 * are installed and provides the default selection order.
 *
 * Usage:
 *   import { getAvailableWallets, getWalletById } from "@/lib/wallets";
 *
 *   const wallets = await getAvailableWallets();
 *   // wallets = [freighterAdapter, albedoAdapter, …] (only installed ones)
 *
 *   const adapter = getWalletById("freighter");
 *   const pk = await adapter.getPublicKey();
 */

import type { StellarWalletAdapter, WalletId } from "./types";
import { SUPPORTED_WALLET_IDS } from "./types";
import { freighterAdapter } from "./freighter";
import { albedoAdapter } from "./albedo";
import { xbullAdapter } from "./xbull";
import { rabetAdapter } from "./rabet";

/**
 * All registered wallet adapters, keyed by id.
 * Add new wallet adapters here to make them available everywhere.
 */
const ALL_WALLETS: Record<WalletId, StellarWalletAdapter> = {
  freighter: freighterAdapter,
  albedo: albedoAdapter,
  xbull: xbullAdapter,
  rabet: rabetAdapter,
};

/**
 * Return adapters for wallets that are currently installed in the
 * user's browser. Order follows SUPPORTED_WALLET_IDS (Freighter first).
 */
export async function getAvailableWallets(): Promise<StellarWalletAdapter[]> {
  const results = await Promise.all(
    SUPPORTED_WALLET_IDS.map(async (id) => {
      const adapter = ALL_WALLETS[id];
      try {
        const installed = await adapter.isInstalled();
        return installed ? adapter : null;
      } catch {
        return null;
      }
    }),
  );
  return results.filter(Boolean) as StellarWalletAdapter[];
}

/**
 * Synchronously look up a wallet adapter by id. Returns undefined
 * when the id is unrecognised (caller should fall back gracefully).
 */
export function getWalletById(id: string): StellarWalletAdapter | undefined {
  if (!isSupportedWalletId(id)) return undefined;
  return ALL_WALLETS[id];
}

/**
 * Type-narrow a string to a WalletId.
 */
export function isSupportedWalletId(id: string): id is WalletId {
  return (SUPPORTED_WALLET_IDS as readonly string[]).includes(id);
}

/**
 * Resolve the best wallet to use. Priority:
 * 1. Stored wallet preference (from localStorage).
 * 2. First available wallet (Freighter > Albedo > xBull > Rabet).
 * 3. Freighter as the universal fallback.
 */
export async function resolveDefaultWallet(): Promise<{
  adapter: StellarWalletAdapter;
  id: WalletId;
} | null> {
  // Check localStorage for a previously saved wallet preference
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem("indigopay_wallet_id");
      if (stored && isSupportedWalletId(stored)) {
        const adapter = ALL_WALLETS[stored];
        const installed = await adapter.isInstalled();
        if (installed) return { adapter, id: stored };
      }
    } catch {
      // localStorage may throw in some contexts (e.g. private browsing);
      // fall through to detection.
    }
  }

  // Fall back to first available wallet in priority order
  const available = await getAvailableWallets();
  if (available.length > 0) {
    const adapter = available[0];
    return { adapter, id: adapter.id as WalletId };
  }

  // No wallet found — caller should show the install prompt
  return null;
}

/**
 * Persist the user's wallet selection to localStorage so subsequent
 * visits automatically reconnect to the same wallet.
 */
export function persistWalletSelection(id: WalletId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("indigopay_wallet_id", id);
  } catch {
    // Silently ignore localStorage errors (private browsing, quota).
  }
}

/**
 * Clear the persisted wallet preference (used on disconnect).
 */
export function clearWalletSelection(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("indigopay_wallet_id");
  } catch {
    // Silently ignore.
  }
}
