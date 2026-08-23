/**
 * lib/__tests__/oraclePrice.test.ts — Unit tests for lib/oraclePrice.ts
 *
 * Covers the oracle-backed XLM/USD price source: URL selection, response
 * envelope unwrapping, metadata extraction (updatedAt, source), and graceful
 * null fallbacks for invalid or unavailable oracle responses.
 *
 * @jest-environment jsdom
 */
import { fetchXlmPrice } from "@/lib/oraclePrice";

const ORACLE_URL = "http://localhost:4000/api/oracle/price";

// Helper: create a mock fetch Response object.
function mockFetchResponse(body: unknown, init?: { status?: number }) {
  const status = init?.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
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

    const result = await fetchXlmPrice();

    expect(result.price).toBe(0.125);
    expect(mockFetch).toHaveBeenCalledWith(ORACLE_URL, { signal: undefined });
  });

  it("returns updatedAt and source from the response", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0.12, updatedAt: 1_700_000_000_000, source: "stellar-dex" },
      }),
    );

    const result = await fetchXlmPrice();

    expect(result.updatedAt).toBe(1_700_000_000_000);
    expect(result.source).toBe("stellar-dex");
  });

  it("includes fetchedAt (epoch ms) in the result", async () => {
    const before = Date.now();
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0.12, updatedAt: null, source: "oracle" },
      }),
    );

    const result = await fetchXlmPrice();
    const after = Date.now();

    expect(result.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(result.fetchedAt).toBeLessThanOrEqual(after);
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

  it("returns price: null when the oracle has no cached price", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: null, updatedAt: null, source: "stellar-dex" },
      }),
    );

    const result = await fetchXlmPrice();
    expect(result.price).toBeNull();
  });

  it("returns price: null when the price is not a positive number", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0, updatedAt: 1_700_000_000_000, source: "stellar-dex" },
      }),
    );

    const result = await fetchXlmPrice();
    expect(result.price).toBeNull();
  });

  it("returns price: null on a non-ok response", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockFetchResponse({ error: "down" }, { status: 503 }));

    const result = await fetchXlmPrice();
    expect(result.price).toBeNull();
  });

  it("returns price: null when the fetch rejects (oracle unavailable)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network error"));

    const result = await fetchXlmPrice();
    expect(result.price).toBeNull();
  });

  it("uses 'oracle' as fallback source when source field is missing", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { price: 0.1, updatedAt: null },
      }),
    );

    const result = await fetchXlmPrice();
    expect(result.source).toBe("oracle");
  });
});
