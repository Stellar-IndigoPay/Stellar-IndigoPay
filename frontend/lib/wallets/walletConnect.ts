/**
 * lib/wallets/walletConnect.ts
 *
 * WalletConnect wallet adapter (issue #1096, Workstream 4).
 *
 * WalletConnect pairs mobile Stellar wallets (Lobstr, Vibrant, …) with the
 * dApp through a relay and a QR code.  The protocol-level constraint is
 * documented in the issue: WalletConnect v2 has no Stellar namespace and
 * v1 was sunset in 2023, so a live pairing additionally requires a
 * WalletConnect Cloud `projectId` and a client injected by the host
 * environment (dApp shell / bridge).  This adapter therefore follows the
 * same injected-global pattern as the Albedo/xBull/Rabet adapters: it
 * drives a `window.walletConnect` client when one is present, and reports
 * "not installed" otherwise — so the picker never offers a pairing that
 * cannot actually complete.  Unit/E2E tests inject a stub client and
 * exercise the full connect → sign flow (the issue's mock acceptance
 * criterion).
 *
 * @see https://walletconnect.com
 */
import type { StellarWalletAdapter } from "./types";

/** Minimal WalletConnect client surface the adapter drives. */
export interface WalletConnectClient {
  connect: () => Promise<{ publicKey?: string; address?: string; pubkey?: string }>;
  getPublicKey: () => Promise<string>;
  sign: (params: { xdr: string; networkPassphrase: string }) => Promise<{
    signedXDR?: string;
    signed_envelope_xdr?: string;
    xdr?: string;
  }>;
}

function getWalletConnectClient(): WalletConnectClient | null {
  if (typeof window === "undefined") return null;
  const client = (window as unknown as Record<string, unknown>).walletConnect;
  if (!client) return null;
  return client as WalletConnectClient;
}

export const walletConnectAdapter: StellarWalletAdapter = {
  id: "walletconnect",
  name: "WalletConnect",
  description:
    "Pair any WalletConnect-enabled mobile Stellar wallet (Lobstr, Vibrant) via QR code.",
  installUrl: "https://walletconnect.com/explorer",

  async isInstalled(): Promise<boolean> {
    try {
      const client = getWalletConnectClient();
      return !!(
        client &&
        typeof client.connect === "function" &&
        typeof client.sign === "function"
      );
    } catch {
      return false;
    }
  },

  async getPublicKey(): Promise<string> {
    const client = getWalletConnectClient();
    if (!client) {
      throw new Error("WalletConnect not installed. Visit https://walletconnect.com");
    }
    // connect() surfaces the pairing prompt (QR code) and resolves with the
    // wallet's address once paired.
    const connected = await client.connect();
    const pk = connected?.publicKey ?? connected?.address ?? connected?.pubkey ?? "";
    if (!pk) {
      const direct = await client.getPublicKey();
      if (!direct) throw new Error("WalletConnect returned no public key.");
      return direct;
    }
    return pk;
  },

  async signTransaction(
    xdr: string,
    opts: { networkPassphrase: string; network: "TESTNET" | "MAINNET" },
  ): Promise<string> {
    const client = getWalletConnectClient();
    if (!client || typeof client.sign !== "function") {
      throw new Error("WalletConnect not installed. Visit https://walletconnect.com");
    }
    const { signedXDR, signed_envelope_xdr: signedEnvelopeXdr, xdr: signedXdr } =
      await client.sign({ xdr, networkPassphrase: opts.networkPassphrase });
    const signed = signedXDR ?? signedEnvelopeXdr ?? signedXdr;
    if (!signed) throw new Error("WalletConnect returned no signed XDR.");
    return signed;
  },
};
