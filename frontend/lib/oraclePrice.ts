/**
 * lib/oraclePrice.ts — XLM/USD price source.
 *
 * Fetches the XLM/USD conversion rate from the backend's on-chain price
 * oracle endpoint (GET /api/oracle/price) instead of a hardcoded third-party
 * CoinGecko feed. This keeps the displayed donation value in lockstep with the
 * project's own oracle (a core v2.0 feature) and removes CoinGecko as a hard
 * dependency.
 *
 * Returns `null` when the oracle is unavailable so callers can render without
 * a USD equivalent rather than failing the page.
 */

export interface OraclePriceResponse {
  success: boolean;
  data: {
    price: number | null;
    updatedAt: number | null;
    source: string;
  };
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * Fetch the current XLM/USD price from the backend oracle.
 *
 * @param signal - Optional AbortSignal to cancel the in-flight request.
 * @returns The XLM/USD price, or `null` if it is unavailable or invalid.
 */
export async function fetchXlmPrice(
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const res = await fetch(`${API_BASE}/api/oracle/price`, { signal });
    if (!res.ok) return null;

    const body = (await res.json()) as Partial<OraclePriceResponse>;
    const price = body?.data?.price;
    return typeof price === "number" && price > 0 ? price : null;
  } catch {
    // Oracle unavailable — callers render without a USD equivalent.
    return null;
  }
}
