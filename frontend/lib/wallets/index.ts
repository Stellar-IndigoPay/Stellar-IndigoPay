import type { StellarWalletAdapter, WalletId } from "./types";
import { SUPPORTED_WALLET_IDS } from "./types";
import { freighterAdapter } from "./freighterAdapter";
import { albedoAdapter } from "./albedoAdapter";
import { xbullAdapter } from "./xbullAdapter";
import { walletConnectAdapter } from "./walletConnectAdapter";

const ALL_WALLETS: Record<WalletId, StellarWalletAdapter> = {
  freighter: freighterAdapter,
  albedo: albedoAdapter,
  xbull: xbullAdapter,
  walletConnect: walletConnectAdapter,
};

export async function getAvailableWallets(): Promise<StellarWalletAdapter[]> {
  if (typeof window !== "undefined" && (window as any).__test_publicKey__) { return [freighterAdapter]; }
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

export function getWalletById(id: string): StellarWalletAdapter | undefined {
  if (!isSupportedWalletId(id)) return undefined;
  return ALL_WALLETS[id];
}

export function isSupportedWalletId(id: string): id is WalletId {
  return (SUPPORTED_WALLET_IDS as readonly string[]).includes(id);
}

export async function resolveDefaultWallet(): Promise<{
  adapter: StellarWalletAdapter;
  id: WalletId;
} | null> {
  if (typeof window !== "undefined") {
    try {
      const stored = window.localStorage.getItem("indigopay_wallet_id");
      if (stored && isSupportedWalletId(stored)) {
        const adapter = ALL_WALLETS[stored];
        const installed = await adapter.isInstalled();
        if (installed) return { adapter, id: stored };
      }
    } catch {
    }
  }

  const available = await getAvailableWallets();
  if (available.length > 0) {
    const adapter = available[0];
    return { adapter, id: adapter.id as WalletId };
  }

  return null;
}

export function persistWalletSelection(id: WalletId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem("indigopay_wallet_id", id);
  } catch {
  }
}

export function clearWalletSelection(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem("indigopay_wallet_id");
  } catch {
  }
}
