import type { StellarWalletAdapter } from "./types";

export const walletConnectAdapter: StellarWalletAdapter = {
  id: "walletConnect",
  name: "WalletConnect",
  description: "Mock WalletConnect",
  installUrl: "https://walletconnect.com/",
  async isInstalled(): Promise<boolean> { return true; },
  async connect(): Promise<void> { console.log("WalletConnect connected"); },
  async getPublicKey(): Promise<string> { return "GBWALLETCONNECTMOCKPUBLICKEYAAAAAAAAAAAAAAAAAAAAAAAAAA"; },
  async signTransaction(xdr: string, opts: any): Promise<string> { return xdr; },
};
