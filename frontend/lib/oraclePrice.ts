/**
 * lib/oraclePrice.ts — XLM/USD price source.
 *
 * Fetches the XLM/USD conversion rate from the backend's on-chain price
 * oracle endpoint (GET /api/oracle/price) instead of a hardcoded third-party
 * CoinGecko feed. This keeps the displayed donation value in lockstep with the
 * project's own oracle (a core v2.0 feature) and removes CoinGecko as a hard
 * dependency.
 *
 * Returns a structured {@link PriceFetchResult} so callers can track
 * staleness, source, and age — rather than just the raw number.
 */

export interface OraclePriceResponse {
  success: boolean;
  data: {
    price: number | null;
    updatedAt: number | null;
    source: string;
  };
}

/**
 * Full result returned by {@link fetchXlmPrice}.
 *
 * `price` is `null` when the oracle is unavailable or has no valid data.
 * `updatedAt` is a Unix-millisecond timestamp from the oracle (preferred
 * over the client clock to avoid skew).  `source` identifies the oracle
 * backend that produced the price.
 */
export interface PriceFetchResult {
  price: number | null;
  /** Unix-millisecond timestamp when the price was last updated on the oracle side. */
  updatedAt: number | null;
  /** Human-readable source identifier, e.g. "stellar-dex". */
  source: string;
  /** True when the oracle call succeeded and returned a valid price. */
  ok: boolean;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

/**
 * Fetch the current XLM/USD price from the backend oracle.
 *
 * Returns a full {@link PriceFetchResult} instead of a bare number so that
 * the `PriceProvider` can expose staleness metadata to consumers.
 *
 * Never throws — all errors are returned as `{ ok: false, price: null, … }`.
 *
 * @param signal - Optional AbortSignal to cancel the in-flight request.
 */
export async function fetchXlmPrice(
  signal?: AbortSignal,
): Promise<PriceFetchResult> {
  try {
    const res = await fetch(`${API_BASE}/api/oracle/price`, { signal });
    if (!res.ok) {
      return { price: null, updatedAt: null, source: "unknown", ok: false };
    }

    const body = (await res.json()) as Partial<OraclePriceResponse>;
    const price = body?.data?.price;
    const updatedAt = body?.data?.updatedAt ?? null;
    const source = body?.data?.source ?? "unknown";

    const validPrice =
      typeof price === "number" && price > 0 ? price : null;

    return {
      price: validPrice,
      updatedAt: typeof updatedAt === "number" ? updatedAt : null,
      source: typeof source === "string" ? source : "unknown",
      ok: validPrice !== null,
    };
  } catch (err) {
    // Swallow AbortError silently — it is an intentional cancellation.
    if (err instanceof Error && err.name === "AbortError") {
      return { price: null, updatedAt: null, source: "unknown", ok: false };
    }
    // Oracle unavailable — callers render without a USD equivalent.
    return { price: null, updatedAt: null, source: "unknown", ok: false };
  }
}
