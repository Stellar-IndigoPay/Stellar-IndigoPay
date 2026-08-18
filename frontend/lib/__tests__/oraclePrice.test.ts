/**
 * lib/__tests__/oraclePrice.test.ts — Unit tests for lib/oraclePrice.ts
 *
 * Covers the oracle-backed XLM/USD price source: URL selection, response
 * envelope unwrapping, and graceful `null` fallbacks for invalid or
 * unavailable oracle responses.
 *
 * @jest-environment jsdom
 */
import { fetchXlmPrice } from "@/lib/oraclePrice";

const ORACLE_URL = "http://localhost:4000/api/oracle/price";

// Helper: create a mock fetch Response object.
function mockFetchResponse(body: unknown, init?: { status?: number }) {
  return {
    ok: init?.status ? init.status >= 200 && init.status < 300 : true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe("fetchXlmPrice", () => {
  it("fetches the backend oracle endpoint and returns its price", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0.125, updatedAt: 1_700_000_000_000, source: "stellar-dex" },
      }),
    );
    global.fetch = mockFetch;

    const price = await fetchXlmPrice();

    expect(price).toBe(0.125);
    expect(mockFetch).toHaveBeenCalledWith(ORACLE_URL, { signal: undefined });
  });

  it("passes the abort signal through to fetch", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0.125, updatedAt: null, source: "stellar-dex" },
      }),
    );
    global.fetch = mockFetch;

    const controller = new AbortController();
    await fetchXlmPrice(controller.signal);

    expect(mockFetch).toHaveBeenCalledWith(ORACLE_URL, {
      signal: controller.signal,
    });
  });

  it("returns null when the oracle has no cached price", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: null, updatedAt: null, source: "stellar-dex" },
      }),
    );

    await expect(fetchXlmPrice()).resolves.toBeNull();
  });

  it("returns null when the price is not a positive number", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0, updatedAt: 1_700_000_000_000, source: "stellar-dex" },
      }),
    );

    await expect(fetchXlmPrice()).resolves.toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockFetchResponse({ error: "down" }, { status: 503 }));

    await expect(fetchXlmPrice()).resolves.toBeNull();
  });

  it("returns null when the fetch rejects (oracle unavailable)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    await expect(fetchXlmPrice()).resolves.toBeNull();
  });
});
