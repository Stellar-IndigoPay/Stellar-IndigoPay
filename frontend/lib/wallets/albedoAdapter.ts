import type { StellarWalletAdapter } from "./types";

export const albedoAdapter: StellarWalletAdapter = {
  id: "albedo",
  name: "Albedo",
  description: "Albedo Wallet",
  installUrl: "https://albedo.link",
  async isInstalled(): Promise<boolean> {
    return typeof window !== "undefined" && !!(window as any).albedo;
  },
  async connect(): Promise<void> {
    const albedo = (await import("@albedo-link/intent")).default;
    await albedo.publicKey({});
  },
  async getPublicKey(): Promise<string> {
    const albedo = (await import("@albedo-link/intent")).default;
    const res = await albedo.publicKey({});
    return res.pubkey;
  },
  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" }
  ): Promise<string> {
    const albedo = (await import("@albedo-link/intent")).default;
    const res = await albedo.tx({
      xdr: xdr,
      network: opts.network === "TESTNET" ? "testnet" : "public"
    });
    return res.signed_envelope_xdr;
  },
};
