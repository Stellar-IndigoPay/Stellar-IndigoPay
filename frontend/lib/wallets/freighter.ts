/**
 * lib/wallets/freighter.ts
 *
 * Freighter wallet adapter. Wraps @stellar/freighter-api behind the
 * StellarWalletAdapter interface so it can be used interchangeably
 * with Albedo, xBull, and Rabet.
 *
 * The existing helpers in `lib/wallet.ts` continue to work for
 * non-React callers (workers, scripts, tests) — this adapter is a
 * thin facade over the same @stellar/freighter-api primitives.
 */
import {
  isConnected,
  getPublicKey,
  signTransaction,
  requestAccess,
} from "@stellar/freighter-api";
import type { StellarWalletAdapter } from "./types";

/**
 * Test environments short-circuit detection: if `__test_publicKey__` is
 * set on `window`, we consider Freighter "installed" so unit/e2e tests
 * can bypass the real extension.
 */
function hasTestPublicKey(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as Record<string, unknown>).__test_publicKey__
  );
}

function getTestPublicKey(): string {
  return (window as unknown as Record<string, string>).__test_publicKey__;
}

export const freighterAdapter: StellarWalletAdapter = {
  id: "freighter",
  name: "Freighter",
  description:
    "The most popular Stellar wallet. Best-in-class UX with built-in DEX access.",
  installUrl: "https://freighter.app",

  async isInstalled(): Promise<boolean> {
    if (hasTestPublicKey()) return true;
    try {
      const result = await isConnected();
      return typeof result === "boolean" ? result : (result as { isConnected: boolean }).isConnected;
    } catch {
      return false;
    }
  },

  async getPublicKey(): Promise<string> {
    if (hasTestPublicKey()) return getTestPublicKey();
    await requestAccess();
    const result = await getPublicKey();
    const pk =
      typeof result === "string"
        ? result
        : (result as { publicKey?: string; address?: string })?.publicKey ||
          (result as { publicKey?: string; address?: string })?.address;
    if (!pk) throw new Error("Freighter returned no public key.");
    return pk;
  },

  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string> {
    if (hasTestPublicKey()) return xdr;
    const result = await signTransaction(xdr, {
      networkPassphrase: opts.networkPassphrase,
      network: opts.network,
    });
    const signed =
      typeof result === "string"
        ? result
        : (result as { signedTransaction?: string })?.signedTransaction;
    if (!signed) throw new Error("Freighter returned no signed XDR.");
    return signed;
  },
};
