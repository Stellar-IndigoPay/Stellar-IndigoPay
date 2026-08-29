import type { StellarWalletAdapter } from "./types";
import { xBullWalletConnect } from "@creit.tech/xbull-wallet-connect";

export const xbullAdapter: StellarWalletAdapter = {
  id: "xbull",
  name: "xBull",
  description: "xBull Wallet",
  installUrl: "https://xbull.app",
  async isInstalled(): Promise<boolean> {
    return !!((window as any).xBullSDK || (window as any)?.webkit?.messageHandlers?.cordova_iab);
  },
  async connect(): Promise<void> {
    const bridge = new xBullWalletConnect();
    await bridge.connect();
  },
  async getPublicKey(): Promise<string> {
    const bridge = new xBullWalletConnect();
    const pubKey = await bridge.connect();
    bridge.closeConnections();
    return pubKey;
  },
  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" }
  ): Promise<string> {
    const bridge = new xBullWalletConnect();
    const signed = await bridge.sign({
      xdr,
      network: opts.network
    });
    bridge.closeConnections();
    return signed;
  },
};
