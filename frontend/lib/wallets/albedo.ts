/**
 * lib/wallets/albedo.ts
 *
 * Albedo wallet adapter. Albedo injects `window.albedo` into the page
 * so no npm dependency is needed — we communicate via its injected API.
 *
 * Albedo is a community-favourite Stellar wallet that works as a
 * browser extension and also offers a standalone web signer.
 *
 * @see https://albedo.link
 */
import type { StellarWalletAdapter } from "./types";

interface AlbedoPublicKeyResponse {
  pubkey: string;
}

interface AlbedoSignResponse {
  signed_envelope_xdr: string;
}

function getAlbedo(): {
  publicKey: () => Promise<AlbedoPublicKeyResponse>;
  tx: (params: { xdr: string; network?: string }) => Promise<AlbedoSignResponse>;
} | null {
  if (typeof window === "undefined") return null;
  return (window as unknown as Record<string, unknown>).albedo as ReturnType<typeof getAlbedo> | null;
}

export const albedoAdapter: StellarWalletAdapter = {
  id: "albedo",
  name: "Albedo",
  description:
    "Community-trusted Stellar wallet. Supports both browser extension and standalone web signer flows.",
  installUrl: "https://albedo.link",

  async isInstalled(): Promise<boolean> {
    try {
      const albedo = getAlbedo();
      if (!albedo || typeof albedo.publicKey !== "function") return false;
      // Albedo might be present but the extension isn't unlocked —
      // a quick publicKey() call confirms it's available.
      await albedo.publicKey();
      return true;
    } catch {
      return false;
    }
  },

  async getPublicKey(): Promise<string> {
    const albedo = getAlbedo();
    if (!albedo || typeof albedo.publicKey !== "function") {
      throw new Error("Albedo not installed. Visit https://albedo.link");
    }
    const { pubkey } = await albedo.publicKey();
    if (!pubkey) throw new Error("Albedo returned no public key.");
    return pubkey;
  },

  async signTransaction(
    xdr: string,
    _opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string> {
    const albedo = getAlbedo();
    if (!albedo || typeof albedo.tx !== "function") {
      throw new Error("Albedo not installed. Visit https://albedo.link");
    }
    const { signed_envelope_xdr } = await albedo.tx({ xdr });
    if (!signed_envelope_xdr) throw new Error("Albedo returned no signed XDR.");
    return signed_envelope_xdr;
  },
};
