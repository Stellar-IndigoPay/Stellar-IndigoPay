import type { StellarWalletAdapter } from "./types";

export const freighterAdapter: StellarWalletAdapter = {
  id: "freighter",
  name: "Freighter",
  description: "Mock Freighter Wallet",
  installUrl: "https://freighter.app",
  async isInstalled(): Promise<boolean> { return true; },
  async connect(): Promise<void> { console.log("Freighter connected"); },
  async getPublicKey(): Promise<string> { return "GBFREIGHTERMOCKPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAA"; },
  async signTransaction(xdr: string, opts: any): Promise<string> { return xdr; },
};
