import type { StellarWalletAdapter } from "./types";

export const albedoAdapter: StellarWalletAdapter = {
  id: "albedo",
  name: "Albedo",
  description: "Mock Albedo Wallet",
  installUrl: "https://albedo.link",
  async isInstalled(): Promise<boolean> { return true; },
  async connect(): Promise<void> { console.log("Albedo connected"); },
  async getPublicKey(): Promise<string> { return "GBALBEDOMOCKPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"; },
  async signTransaction(xdr: string, opts: any): Promise<string> { return xdr; },
};
