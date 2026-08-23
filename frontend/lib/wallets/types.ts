/**
 * lib/wallets/types.ts
 *
 * Wallet adapter interface for the Stellar-IndigoPay multi-wallet layer.
 * Every supported wallet (Freighter, Albedo, xBull, Rabet) implements
 * this interface, so the WalletProvider and UI can treat them uniformly.
 *
 * The adapter is deliberately minimal — only the three operations the
 * dApp actually needs: detect, getPublicKey, and signTransaction.
 */

export interface StellarWalletAdapter {
  /** Unique id used as a key in the wallet registry (e.g. "freighter"). */
  readonly id: string;
  /** Human-readable wallet name displayed in the UI. */
  readonly name: string;
  /** Short description shown in the wallet picker. */
  readonly description: string;
  /** URL where users can install this wallet. */
  readonly installUrl: string;

  /**
   * Returns true when the wallet browser extension is available.
   * Must never throw — return false on any error.
   */
  isInstalled(): Promise<boolean>;

  /**
   * Request permission and return the active Stellar public key (G…).
   * Throws if the user rejects or the wallet is not installed.
   */
  getPublicKey(): Promise<string>;

  /**
   * Sign a transaction XDR (base64) and return the signed XDR.
   * @param xdr - Unsigned transaction envelope XDR.
   * @param opts.networkPassphrase - Stellar network passphrase.
   * @param opts.network - "TESTNET" | "MAINNET" for the wallet UI.
   */
  signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string>;
}

/**
 * All supported wallet ids, in the order they appear in the picker.
 * Freighter first because it has the largest Stellar ecosystem share.
 */
export const SUPPORTED_WALLET_IDS = [
  "freighter",
  "albedo",
  "xbull",
  "rabet",
] as const;

export type WalletId = (typeof SUPPORTED_WALLET_IDS)[number];
