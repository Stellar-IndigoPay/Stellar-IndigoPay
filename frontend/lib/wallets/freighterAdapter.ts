import type { StellarWalletAdapter } from "./types";
import { isConnected, requestAccess, signTransaction } from "@stellar/freighter-api";

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
  description: "Freighter Wallet",
  installUrl: "https://freighter.app",
  async isInstalled(): Promise<boolean> {
    if (hasTestPublicKey()) return true;
    return await isConnected();
  },
  async connect(): Promise<void> {
    if (hasTestPublicKey()) return;
    await requestAccess();
  },
  async getPublicKey(): Promise<string> {
    if (hasTestPublicKey()) return getTestPublicKey();
    const pubKey = await requestAccess();
    if (!pubKey) throw new Error("Could not get public key from Freighter");
    return pubKey;
  },
  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" }
  ): Promise<string> {
    if (hasTestPublicKey()) return xdr;
    const signed = await signTransaction(xdr, { network: opts.network });
    return signed;
  },
};
