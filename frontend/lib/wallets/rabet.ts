/**
 * lib/wallets/rabet.ts
 *
 * Rabet wallet adapter. Rabet injects `window.rabet` and is one of the
 * oldest Stellar community wallets with strong adoption in the ecosystem.
 *
 * @see https://rabet.io
 */
import type { StellarWalletAdapter } from "./types";

interface RabetSignResponse {
  xdr: string;
}

function getRabet(): {
  connect: () => Promise<void>;
  getPublicKey: () => Promise<string>;
  sign: (xdr: string, network: string) => Promise<RabetSignResponse>;
} | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as Record<string, unknown>).rabet as ReturnType<typeof getRabet> | null;
}

export const rabetAdapter: StellarWalletAdapter = {
  id: "rabet",
  name: "Rabet",
  description:
    "Pioneering Stellar wallet with a loyal community. One of the earliest and most battle-tested Stellar extensions.",
  installUrl: "https://rabet.io",

  async isInstalled(): Promise<boolean> {
    try {
      const rabet = getRabet();
      return !!(rabet && typeof rabet.getPublicKey === "function");
    } catch {
      return false;
    }
  },

  async getPublicKey(): Promise<string> {
    const rabet = getRabet();
    if (!rabet || typeof rabet.getPublicKey !== "function") {
      throw new Error("Rabet not installed. Visit https://rabet.io");
    }
    if (typeof rabet.connect === "function") {
      await rabet.connect();
    }
    const pk = await rabet.getPublicKey();
    if (!pk) throw new Error("Rabet returned no public key.");
    return pk;
  },

  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string> {
    const rabet = getRabet();
    if (!rabet || typeof rabet.sign !== "function") {
      throw new Error("Rabet not installed. Visit https://rabet.io");
    }
    const network = opts.network === "MAINNET" ? "mainnet" : "testnet";
    const { xdr: signedXDR } = await rabet.sign(xdr, network);
    if (!signedXDR) throw new Error("Rabet returned no signed XDR.");
    return signedXDR;
  },
};
