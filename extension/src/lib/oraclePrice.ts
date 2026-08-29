/** Small extension-local adapter for the existing XLM/USD oracle endpoint. */

export type PriceFetcher = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function fetchXlmUsdPrice(
  backendUrl: string,
  fetcher?: PriceFetcher,
): Promise<number | null> {
  try {
    const request =
      fetcher ??
      (typeof fetch === "function" ? fetch.bind(globalThis) : undefined);
    if (!request) return null;

    const baseUrl = backendUrl.replace(/\/+$/, "");
    const response = await request(`${baseUrl}/api/oracle/price`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const body = (await response.json()) as {
      data?: { price?: unknown };
    };
    const price = body?.data?.price;
    return typeof price === "number" && Number.isFinite(price) && price > 0
      ? price
      : null;
  } catch {
    return null;
  }
}

export function formatApproximateFiat(
  xlmAmount: unknown,
  xlmUsdPrice: number | null,
): string | null {
  const normalizedAmount =
    typeof xlmAmount === "string" ? xlmAmount.trim() : xlmAmount;
  if (
    (typeof normalizedAmount !== "string" && typeof normalizedAmount !== "number") ||
    normalizedAmount === ""
  ) {
    return null;
  }

  const amount = Number(normalizedAmount);
  if (!Number.isFinite(amount) || xlmUsdPrice === null || !Number.isFinite(xlmUsdPrice)) {
    return null;
  }
  return `≈ $${(amount * xlmUsdPrice).toFixed(2)} USD`;
}
