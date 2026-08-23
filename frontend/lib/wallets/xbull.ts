/**
 * lib/wallets/xbull.ts
 *
 * xBull wallet adapter. xBull injects `window.xBullSDK` — a modern
 * Stellar wallet with a clean UI and good developer ergonomics.
 *
 * @see https://xbull.app
 */
import type { StellarWalletAdapter } from "./types";

interface XBullSignResponse {
  signedXDR: string;
}

function getXBull(): {
  connect: () => Promise<void>;
  getPublicKey: () => Promise<string>;
  sign: (params: { xdr: string }) => Promise<XBullSignResponse>;
} | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as Record<string, unknown>).xBullSDK as ReturnType<typeof getXBull> | null;
}

export const xbullAdapter: StellarWalletAdapter = {
  id: "xbull",
  name: "xBull",
  description:
    "Sleek Stellar wallet with multi-account support. Great for power users managing several Stellar identities.",
  installUrl: "https://xbull.app",

  async isInstalled(): Promise<boolean> {
    try {
      const xbull = getXBull();
      return !!(xbull && typeof xbull.getPublicKey === "function");
    } catch {
      return false;
    }
  },

  async getPublicKey(): Promise<string> {
    const xbull = getXBull();
    if (!xbull || typeof xbull.getPublicKey !== "function") {
      throw new Error("xBull not installed. Visit https://xbull.app");
    }
    // xBull connect() opens the permission prompt on first use
    if (typeof xbull.connect === "function") {
      await xbull.connect();
    }
    const pk = await xbull.getPublicKey();
    if (!pk) throw new Error("xBull returned no public key.");
    return pk;
  },

  async signTransaction(
    xdr: string,
    _opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string> {
    const xbull = getXBull();
    if (!xbull || typeof xbull.sign !== "function") {
      throw new Error("xBull not installed. Visit https://xbull.app");
    }
    const { signedXDR } = await xbull.sign({ xdr });
    if (!signedXDR) throw new Error("xBull returned no signed XDR.");
    return signedXDR;
  },
};
