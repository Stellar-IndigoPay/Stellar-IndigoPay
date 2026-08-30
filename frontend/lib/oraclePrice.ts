/**
 * lib/oraclePrice.ts — XLM/USD price source.
 *
 * Fetches the XLM/USD conversion rate from the backend's on-chain price
 * oracle endpoint (GET /api/oracle/price) instead of a hardcoded third-party
 * CoinGecko feed. This keeps the displayed donation value in lockstep with the
 * project's own oracle (a core v2.0 feature) and removes CoinGecko as a hard
 * dependency.
 *
 * Returns structured metadata including the price, oracle source, and timestamp
 * so the PriceProvider can compute staleness from oracle-side timestamps rather
 * than the client clock — guarding against clock skew.
 *
 * Returns a {@link FetchPriceResult} with `price: null` when the oracle is
 * unavailable; callers render without a USD equivalent rather than failing.
 */

export interface OraclePriceResponse {
  success: boolean;
  data: {
    price: number | null;
    updatedAt: number | null; // epoch ms from oracle
    source: string;
  };
}

/**
 * Result returned by {@link fetchXlmPrice}.
 *
 * `price` is the XLM/USD rate, or `null` when unavailable.
 * `updatedAt` is the oracle-side epoch-ms timestamp (preferred over client
 * clock for staleness computation to handle clock skew).
 * `source` identifies the oracle data source.
 * `fetchedAt` is the local epoch-ms at the moment the response arrived —
 * used as a fallback when `updatedAt` is null.
 */
export interface FetchPriceResult {
  price: number | null;
  updatedAt: number | null;
  source: string;
  fetchedAt: number;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * Fetch the current XLM/USD price from the backend oracle.
 *
 * Always resolves (never rejects): network or parse errors produce a result
 * with `price: null` so callers can render without a USD equivalent instead
 * of showing an error page.
 *
 * @param signal - Optional AbortSignal to cancel the in-flight request.
 * @returns Structured price result; `price` is `null` when unavailable.
 */
export async function fetchXlmPrice(
  signal?: AbortSignal,
): Promise<FetchPriceResult> {
  const fetchedAt = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/oracle/price`, { signal });
    if (!res.ok) {
      return { price: null, updatedAt: null, source: "oracle", fetchedAt };
    }

    const body = (await res.json()) as Partial<OraclePriceResponse>;
    const data = body?.data;
    const price =
      typeof data?.price === "number" && data.price > 0 ? data.price : null;
    const updatedAt =
      typeof data?.updatedAt === "number" ? data.updatedAt : null;
    const source =
      typeof data?.source === "string" && data.source.length > 0
        ? data.source
        : "oracle";

    return { price, updatedAt, source, fetchedAt };
  } catch {
    // Oracle unavailable — callers render without a USD equivalent.
    return { price: null, updatedAt: null, source: "oracle", fetchedAt };
  }
}
