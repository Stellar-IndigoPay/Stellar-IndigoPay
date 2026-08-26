/**
 * lib/wallet.ts — Freighter wallet integration
 */
import {
  isConnected,
  getPublicKey,
  signTransaction,
  requestAccess,
  isAllowed,
} from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "./stellar";
import { resolveDefaultWallet } from "./wallets";

export async function isFreighterInstalled(): Promise<boolean> {
  if (typeof window !== "undefined" && (window as any).__test_publicKey__) {
    return true;
  }
  try {
    const result: any = await isConnected();
    // Handle both boolean and object return types
    return typeof result === "boolean" ? result : result.isConnected;
  } catch {
    return false;
  }
}

export async function connectWallet(): Promise<{
  publicKey: string | null;
  error: string | null;
}> {
  if (typeof window !== "undefined" && (window as any).__test_publicKey__) {
    return { publicKey: (window as any).__test_publicKey__, error: null };
  }
  const installed = await isFreighterInstalled();
  if (!installed)
    return {
      publicKey: null,
      error: "Freighter not installed. Visit https://freighter.app",
    };
  try {
    await requestAccess();
    const result: any = await getPublicKey();
    // Handle both string and object return types
    const publicKey =
      typeof result === "string"
        ? result
        : result?.publicKey || result?.address;
    return { publicKey: publicKey || null, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("User declined"))
      return { publicKey: null, error: "Connection rejected." };
    return { publicKey: null, error: `Connection failed: ${msg}` };
  }
}

export async function getConnectedPublicKey(): Promise<string | null> {
  if (typeof window !== "undefined" && (window as any).__test_publicKey__) {
    return (window as any).__test_publicKey__;
  }
  try {
    const allowedResult: any = await isAllowed();
    // Handle both boolean and object return types
    const isUserAllowed =
      typeof allowedResult === "boolean"
        ? allowedResult
        : allowedResult.isAllowed;
    if (!isUserAllowed) return null;

    const result: any = await getPublicKey();
    // Handle both string and object return types
    const publicKey =
      typeof result === "string"
        ? result
        : result?.publicKey || result?.address;
    return publicKey || null;
  } catch {
    return null;
  }
}

export async function signTransactionWithWallet(
  xdr: string,
): Promise<{ signedXDR: string | null; error: string | null }> {
  if (typeof window !== "undefined" && (window as any).__test_publicKey__) {
    return { signedXDR: xdr, error: null };
  }

  // Workstream 4: signing is wallet-agnostic. The DonateForm signs through
  // whichever adapter the donor connected with (Freighter, Albedo, xBull, or
  // WalletConnect) — resolved from the persisted selection, falling back to
  // detection — rather than being hard-coded to the Freighter extension.
  const network =
    process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
      ? "MAINNET"
      : "TESTNET";

  try {
    const resolved = await resolveDefaultWallet();
    if (resolved) {
      const signedXDR = await resolved.adapter.signTransaction(xdr, {
        networkPassphrase: NETWORK_PASSPHRASE,
        network,
      });
      return { signedXDR: signedXDR || null, error: null };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("User declined") || msg.includes("rejected"))
      return { signedXDR: null, error: "Transaction rejected." };
    return { signedXDR: null, error: `Signing failed: ${msg}` };
  }

  // Fallback: no adapter resolved (e.g. Freighter connected before the
  // adapter registry existed) — sign via the legacy Freighter path.
  try {
    const result: any = await signTransaction(xdr, {
      networkPassphrase: NETWORK_PASSPHRASE,
      network,
    });
    // Handle both string and object return types
    const signedXDR =
      typeof result === "string" ? result : result?.signedTransaction;
    return { signedXDR: signedXDR, error: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("User declined") || msg.includes("rejected"))
      return { signedXDR: null, error: "Transaction rejected." };
    return { signedXDR: null, error: `Signing failed: ${msg}` };
  }
}
