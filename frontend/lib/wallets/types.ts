export interface StellarWalletAdapter {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly installUrl: string;
  isInstalled(): Promise<boolean>;
  connect(): Promise<void>;
  getPublicKey(): Promise<string>;
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string>;
}

export const SUPPORTED_WALLET_IDS = [
  "freighter",
  "albedo",
  "xbull",
  "walletConnect",
] as const;

export type WalletId = (typeof SUPPORTED_WALLET_IDS)[number];
