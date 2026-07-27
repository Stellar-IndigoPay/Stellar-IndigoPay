export interface SEP0007Params {
  destination: string;       // Required
  amount?: string;           // Optional — if absent, let user enter
  memo?: string;
  memo_type?: 'text' | 'id' | 'hash' | 'return';
  asset_code?: string;       // Default: XLM
  asset_issuer?: string;     // Required if asset_code != XLM
  message?: string;
  callback?: string;         // URL to redirect after payment
  network_passphrase?: string; // For testnet/mainnet distinction
}

export function parseSEP0007Params(url: string | null): Partial<SEP0007Params> {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    // Accept both web+stellar:pay and web+stellar://pay forms
    const protocol = parsed.protocol; // includes trailing ':'
    const host = parsed.hostname;
    if (!protocol.includes('web+stellar') || host !== 'pay') {
      return {};
    }
    return {
      destination: parsed.searchParams.get('destination') || '',
      amount: parsed.searchParams.get('amount') || undefined,
      memo: parsed.searchParams.get('memo') || undefined,
      memo_type: (parsed.searchParams.get('memo_type') as SEP0007Params['memo_type']) || undefined,
      asset_code: parsed.searchParams.get('asset_code') || undefined,
      asset_issuer: parsed.searchParams.get('asset_issuer') || undefined,
      message: parsed.searchParams.get('message') || undefined,
      callback: parsed.searchParams.get('callback') || undefined,
      network_passphrase: parsed.searchParams.get('network_passphrase') || undefined,
    };
  } catch (e) {
    return {};
  }
}
import { StrKey } from "@stellar/stellar-sdk";

export interface SEP0007Params {
  destination: string;
  amount?: string;
  memo?: string;
  memo_type?: "text" | "id" | "hash" | "return";
  asset_code?: string;
  asset_issuer?: string;
  message?: string;
  callback?: string;
  network_passphrase?: string;
}

const SUPPORTED_ASSETS = new Set(["XLM", "USDC"]);
const SUPPORTED_MEMO_TYPES = new Set(["text", "id", "hash", "return"]);

export function parseSEP0007Params(url: string | null): Partial<SEP0007Params> {
  if (!url) return {};

  try {
    if (!url.startsWith("web+stellar:")) return {};

    const parsed = new URL(url);
    if (parsed.protocol !== "web+stellar:") return {};

    const operation = parsed.pathname.replace(/^\/+/, "");
    if (operation !== "pay") return {};

    const params = parsed.searchParams;
    const memoType = params.get("memo_type")?.toLowerCase() || undefined;

    return {
      destination: params.get("destination") || "",
      amount: params.get("amount") || undefined,
      memo: params.get("memo") || undefined,
      memo_type: memoType && SUPPORTED_MEMO_TYPES.has(memoType) ? (memoType as SEP0007Params["memo_type"]) : undefined,
      asset_code: params.get("asset_code") || "XLM",
      asset_issuer: params.get("asset_issuer") || undefined,
      message: params.get("message") || undefined,
      callback: params.get("callback") || undefined,
      network_passphrase: params.get("network_passphrase") || undefined,
    };
  } catch {
    return {};
  }
}

export function validateSEP0007Params(params: Partial<SEP0007Params>): string[] {
  const errors: string[] = [];

  if (!params.destination || !StrKey.isValidEd25519PublicKey(params.destination)) {
    errors.push("destination");
  }

  if (params.amount !== undefined) {
    const parsed = Number.parseFloat(params.amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push("amount");
    }
  }

  if (params.asset_code && !SUPPORTED_ASSETS.has(params.asset_code.toUpperCase())) {
    errors.push("asset_code");
  }

  if (params.asset_code && params.asset_code.toUpperCase() !== "XLM" && !params.asset_issuer) {
    errors.push("asset_issuer");
  }

  return errors;
}
