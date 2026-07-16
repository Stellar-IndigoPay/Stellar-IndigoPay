/**
 * lib/dex.ts — Stellar DEX path-finding utilities for IndigoPay
 *
 * Enables donors to contribute using ANY Stellar asset by leveraging
 * Stellar's built-in DEX path payments for automatic conversion to XLM.
 *
 * @see https://developers.stellar.org/docs/learn/encyclopedia/asset-arbitrage
 * @see https://developers.stellar.org/api/resources/paths/
 */
import { Horizon, Asset } from "@stellar/stellar-sdk";
import { server, NETWORK } from "./stellar";

/** Estimated conversion from an arbitrary Stellar asset to native XLM. */
export interface ConversionEstimate {
  /** Source asset code (e.g. "yXLM", "USDT", "BTC"). */
  sourceAsset: string;
  /** Source asset issuer. */
  sourceIssuer: string;
  /** Source balance (decimal string) the donor holds. */
  sourceBalance: string;
  /** Amount of source asset the donor wants to send. */
  sourceAmount: string;
  /** Estimated XLM the project would receive (decimal string). */
  estimatedXLM: string;
  /** Intermediary assets in the conversion path (may be empty). Full issuers preserved. */
  path: Array<{ code: string; issuer: string }>;
  /** Worst-case destination amount per the DEX path. */
  destinationAmount: string;
  /** Best-case source amount per the DEX path. */
  sourceAmountExact: string;
}

/** A non-native Stellar asset held by the donor. */
export interface DonorAsset {
  code: string;
  issuer: string;
  balance: string;
}

/**
 * Query Horizon /paths/strict-send to find the best conversion path
 * from a source asset to native XLM.
 *
 * @param sourceAssetCode - Source asset code (e.g. "USDC", "yXLM").
 * @param sourceAssetIssuer - Source asset issuer account.
 * @param sourceAmount - Decimal amount of the source asset to convert.
 * @returns Conversion estimate with path and estimated XLM, or `null` if no viable path.
 * @throws If Horizon returns an unexpected error.
 */
export async function findBestPath(
  sourceAssetCode: string,
  sourceAssetIssuer: string,
  sourceAmount: string,
): Promise<ConversionEstimate | null> {
  try {
    const sourceAsset = new Asset(sourceAssetCode, sourceAssetIssuer);
    const destAsset = Asset.native();

    const response = await server
      .strictSendPaths(sourceAsset, sourceAmount, [destAsset])
      .call();

    const records = (response as any)._embedded?.records ?? response.records;
    if (!records || !Array.isArray(records) || records.length === 0) {
      return null;
    }

    // Horizon returns paths ordered by best conversion rate first
    const best = records[0];

    // Preserve full issuer addresses for data integrity.
    // Display-formatting (truncation) happens in the UI layer.
    const path: Array<{ code: string; issuer: string }> = (best.path || []).map(
      (p: any) => ({
        code: p.asset_code || "XLM",
        issuer: p.asset_issuer || "",
      }),
    );

    return {
      sourceAsset: sourceAssetCode,
      sourceIssuer: sourceAssetIssuer,
      sourceBalance: "0", // caller fills this in
      sourceAmount,
      estimatedXLM: best.destination_amount,
      path,
      destinationAmount: best.destination_amount,
      sourceAmountExact: sourceAmount,
    };
  } catch (err: any) {
    // If Horizon can't find a path, return null rather than throwing
    if (
      err?.response?.status === 404 ||
      String(err?.message ?? "").includes("not found")
    ) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch all non-native asset balances for a Stellar account, excluding XLM.
 *
 * @param publicKey - Stellar account public key.
 * @returns Array of donor assets with code, issuer, and balance.
 * @throws If the account does not exist, is not funded, or Horizon is unreachable.
 */
export async function getAllBalances(
  publicKey: string,
): Promise<DonorAsset[]> {
  const account = await server.loadAccount(publicKey);
  const assets: DonorAsset[] = [];

  for (const balance of account.balances) {
    if (balance.asset_type === "native") continue;
    // Filter out liquidity pool shares which lack asset_code/asset_issuer
    if (!("asset_code" in balance)) continue;
    // Only include assets with non-zero balance
    const b = parseFloat(balance.balance);
    if (b <= 0) continue;
    assets.push({
      code: balance.asset_code ?? "",
      issuer: balance.asset_issuer ?? "",
      balance: balance.balance,
    });
  }

  return assets;
}

/**
 * Build a human-readable summary of the conversion for the donor UI.
 *
 * @param estimate - A valid conversion estimate from findBestPath().
 * @returns Short summary string like "100 yXLM → ~95.2 XLM".
 */
export function formatConversionEstimate(
  estimate: ConversionEstimate,
): string {
  const xlm = parseFloat(estimate.estimatedXLM).toFixed(4);
  return `${estimate.sourceAmount} ${estimate.sourceAsset} → ~${xlm} XLM`;
}

/**
 * Format the path for display, truncating issuer addresses for readability.
 */
export function formatPathForDisplay(
  path: Array<{ code: string; issuer: string }>,
): string {
  return path
    .map((p) =>
      p.issuer ? `${p.code}:${p.issuer.slice(0, 8)}…` : p.code,
    )
    .join(" → ");
}
