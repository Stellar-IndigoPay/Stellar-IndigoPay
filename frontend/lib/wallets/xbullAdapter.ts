import type { StellarWalletAdapter } from "./types";

export const xbullAdapter: StellarWalletAdapter = {
  id: "xbull",
  name: "xBull",
  description: "Mock xBull Wallet",
  installUrl: "https://xbull.app",
  async isInstalled(): Promise<boolean> { return true; },
  async connect(): Promise<void> { console.log("xBull connected"); },
  async getPublicKey(): Promise<string> { return "GBXBULLMOCKPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; },
  async signTransaction(xdr: string, opts: any): Promise<string> { return xdr; },
};
