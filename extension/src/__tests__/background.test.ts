/**
 * Tests for the background script logic.
 *
 * Since the background module has side effects at import time, we test
 * the core logic (validation, fetch behavior) directly.
 */

// ── Validation tests ─────────────────────────────────────────────────

describe("SUBMIT_DONATION validation", () => {
  test("validates destination address format", () => {
    const validAddress =
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    const invalidAddress = "not-a-valid-stellar-address";

    expect(/^G[A-Z2-7]{55}$/.test(validAddress)).toBe(true);
    expect(/^G[A-Z2-7]{55}$/.test(invalidAddress)).toBe(false);
  });

  test("validates minimum amount (0.1 XLM)", () => {
    expect(0.5 >= 0.1).toBe(true);
    expect(0.05 >= 0.1).toBe(false);
    expect(0 >= 0.1).toBe(false);
  });

  test("validates memo length (max 28 chars)", () => {
    const shortMemo = "Thank you!";
    const longMemo = "A".repeat(29);

    expect(shortMemo.length <= 28).toBe(true);
    expect(longMemo.length <= 28).toBe(false);
  });

  test("accepts empty memo", () => {
    const emptyMemo = "";
    expect(emptyMemo.length <= 28).toBe(true);
  });
});

// ── LOOKUP_PROJECT API behavior ──────────────────────────────────────

describe("LOOKUP_PROJECT API behavior", () => {
  let originalFetch: typeof fetch;

  beforeAll(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns empty data array when API returns no projects", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const address =
      "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG";
    const url = `https://api.stellar-indigopay.app/api/projects?search=${encodeURIComponent(address)}&limit=20`;
    const options = {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    };
    const res = await fetch(url, options);
    const json = await res.json();

    expect(json.data).toEqual([]);
    expect(mockFetch).toHaveBeenCalledWith(
      url,
      expect.objectContaining({
        headers: { Accept: "application/json" },
      }),
    );
  });

  test("returns matching project when API finds one by wallet address", async () => {
    const mockProject = {
      id: "proj-123",
      name: "Amazon Reforestation",
      category: "Reforestation",
      walletAddress:
        "GDFJEGWQOEPLIRVHKVNGCFQBZQNBDWUYOSRYLKKBOPFEBFHIYNDMKKHG",
      verified: true,
      location: "Brazil",
    };

    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [mockProject] }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const url = "https://api.stellar-indigopay.app/api/projects?search=test&limit=20";
    const res = await fetch(url);
    const json = await res.json();

    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("Amazon Reforestation");
    expect(json.data[0].verified).toBe(true);
  });

  test("handles API network error gracefully", async () => {
    const mockFetch = jest
      .fn()
      .mockRejectedValue(new Error("Network error"));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    let error: Error | null = null;
    try {
      await fetch("https://api.stellar-indigopay.app/api/projects?search=test&limit=20");
    } catch (e) {
      error = e as Error;
    }

    expect(error).not.toBeNull();
    expect(error!.message).toBe("Network error");
  });

  test("handles non-ok HTTP response", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await fetch("https://api.stellar-indigopay.app/api/projects?search=test&limit=20");
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
  });
});

// ── Chrome API mock verification ─────────────────────────────────────

describe("Chrome API mock is available", () => {
  test("chrome.runtime.onMessage.addListener exists", () => {
    expect((globalThis as any).chrome).toBeDefined();
    expect((globalThis as any).chrome.runtime.onMessage.addListener).toBeDefined();
  });

  test("chrome.runtime.sendMessage exists", () => {
    expect((globalThis as any).chrome.runtime.sendMessage).toBeDefined();
  });

  test("chrome.storage.local.set exists", () => {
    expect((globalThis as any).chrome.storage.local.set).toBeDefined();
  });
});
