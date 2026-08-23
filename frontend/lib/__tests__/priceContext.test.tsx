/**
 * lib/__tests__/priceContext.test.tsx
 *
 * Unit tests for the PriceProvider and consumer hooks covering:
 *  - Initial fetch on mount
 *  - Poll cadence (next poll scheduled after success)
 *  - Pause on visibilitychange hidden / resume on visible
 *  - Staleness transition (isStale when price age > threshold)
 *  - Degraded state after MAX_CONSECUTIVE_FAILURES
 *  - Recovery from degraded state
 *  - Retry backoff on failure
 *  - Analytics events fired on stale / degraded / recovered transitions
 *
 * Uses jest fake timers and mocked fetch so no real I/O occurs.
 *
 * @jest-environment jsdom
 */
import React from "react";
import { render, act, screen, waitFor } from "@testing-library/react";
import {
  PriceProvider,
  usePriceContext,
  useXlmPrice,
  POLL_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  MAX_CONSECUTIVE_FAILURES,
} from "@/lib/priceContext";

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: any[]) => mockTrackEvent(...args),
}));

// We mock fetchXlmPrice at the module level so individual tests can control
// what it resolves to without network I/O.
const mockFetchXlmPrice = jest.fn();
jest.mock("@/lib/oraclePrice", () => ({
  fetchXlmPrice: (...args: any[]) => mockFetchXlmPrice(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Fresh price result (price is valid, not stale). */
function freshResult(price = 0.12, source = "stellar-dex") {
  return {
    price,
    updatedAt: Date.now(),
    source,
    fetchedAt: Date.now(),
  };
}

/** Stale price result (updatedAt is old enough to exceed STALE_THRESHOLD_MS). */
function staleResult(price = 0.12, source = "stellar-dex") {
  return {
    price,
    updatedAt: Date.now() - STALE_THRESHOLD_MS - 60_000,
    source,
    fetchedAt: Date.now(),
  };
}

/** Failed fetch result (price is null). */
function failedResult() {
  return { price: null, updatedAt: null, source: "oracle", fetchedAt: Date.now() };
}

// ── Consumer component used by tests ─────────────────────────────────────────

function PriceConsumer() {
  const { xlmUsd, isStale, isDegraded, priceAgeMs, source } = usePriceContext();
  return (
    <div>
      <span data-testid="xlmUsd">{xlmUsd ?? "null"}</span>
      <span data-testid="isStale">{String(isStale)}</span>
      <span data-testid="isDegraded">{String(isDegraded)}</span>
      <span data-testid="priceAgeMs">{priceAgeMs ?? "null"}</span>
      <span data-testid="source">{source ?? "null"}</span>
    </div>
  );
}

function XlmPriceConsumer() {
  const price = useXlmPrice();
  return <span data-testid="xlmPrice">{price ?? "null"}</span>;
}

function renderProvider() {
  return render(
    <PriceProvider>
      <PriceConsumer />
    </PriceProvider>,
  );
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.useFakeTimers();
  mockFetchXlmPrice.mockResolvedValue(freshResult());
  mockTrackEvent.mockClear();
  // Reset visibilityState to "visible" before each test.
  Object.defineProperty(document, "visibilityState", {
    writable: true,
    configurable: true,
    value: "visible",
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.clearAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("PriceProvider — initial fetch", () => {
  it("fetches price on mount and exposes it via context", async () => {
    renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("xlmUsd").textContent).toBe("0.12");
    expect(screen.getByTestId("isStale").textContent).toBe("false");
    expect(screen.getByTestId("isDegraded").textContent).toBe("false");
    expect(screen.getByTestId("source").textContent).toBe("stellar-dex");
  });

  it("useXlmPrice() returns the price (backward-compatible)", async () => {
    render(
      <PriceProvider>
        <XlmPriceConsumer />
      </PriceProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("xlmPrice").textContent).toBe("0.12");
  });

  it("starts with null values before the first fetch resolves", () => {
    // Never resolves during this test
    mockFetchXlmPrice.mockReturnValue(new Promise(() => {}));
    renderProvider();

    expect(screen.getByTestId("xlmUsd").textContent).toBe("null");
    expect(screen.getByTestId("isStale").textContent).toBe("false");
    expect(screen.getByTestId("isDegraded").textContent).toBe("false");
  });
});

describe("PriceProvider — poll cadence", () => {
  it("schedules a re-poll after a successful fetch", async () => {
    renderProvider();

    // Flush initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(1);

    // Advance past one poll interval (with jitter the interval is within ±10%)
    await act(async () => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS * 1.2);
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(2);
  });

  it("continues polling after multiple intervals", async () => {
    renderProvider();

    // Flush initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(POLL_INTERVAL_MS * 1.2);
        await Promise.resolve();
      });
    }

    // Initial + 3 polls = 4 total
    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(4);
  });
});

describe("PriceProvider — pause / resume on visibilitychange", () => {
  it("stops polling when the tab becomes hidden", async () => {
    renderProvider();

    // Flush initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(1);

    // Hide the tab
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // Advance well past a poll interval — no new fetches should happen
    await act(async () => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS * 3);
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(1);
  });

  it("re-fetches immediately when the tab becomes visible again", async () => {
    renderProvider();

    // Flush initial fetch
    await act(async () => {
      await Promise.resolve();
    });

    // Hide
    act(() => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await act(async () => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });

    const callsBefore = mockFetchXlmPrice.mock.calls.length;

    // Show tab again
    await act(async () => {
      Object.defineProperty(document, "visibilityState", {
        writable: true,
        configurable: true,
        value: "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(callsBefore + 1);
  });
});

describe("PriceProvider — staleness transitions", () => {
  it("isStale is false when price is fresh", async () => {
    mockFetchXlmPrice.mockResolvedValue(freshResult());
    renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("isStale").textContent).toBe("false");
  });

  it("isStale is true when oracle updatedAt exceeds STALE_THRESHOLD_MS", async () => {
    mockFetchXlmPrice.mockResolvedValue(staleResult());
    renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("isStale").textContent).toBe("true");
  });

  it("emits price_stale analytics event on stale transition", async () => {
    mockFetchXlmPrice.mockResolvedValue(staleResult());
    renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "price_stale",
      expect.objectContaining({ priceAgeMs: expect.any(Number) }),
    );
  });

  it("does not emit price_stale analytics event when price is fresh", async () => {
    mockFetchXlmPrice.mockResolvedValue(freshResult());
    renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockTrackEvent).not.toHaveBeenCalledWith("price_stale", expect.anything());
  });

  it("emits price_stale only once even after multiple polls while stale", async () => {
    mockFetchXlmPrice.mockResolvedValue(staleResult());
    renderProvider();

    // Flush initial + 2 more polls
    for (let i = 0; i < 3; i++) {
      await act(async () => {
        jest.advanceTimersByTime(POLL_INTERVAL_MS * 1.2);
        await Promise.resolve();
      });
    }

    const staleCalls = mockTrackEvent.mock.calls.filter(
      ([name]) => name === "price_stale",
    );
    expect(staleCalls).toHaveLength(1);
  });
});

describe("PriceProvider — degraded state", () => {
  it("enters degraded state after MAX_CONSECUTIVE_FAILURES", async () => {
    mockFetchXlmPrice.mockResolvedValue(failedResult());
    renderProvider();

    // Flush initial fetch + enough backoff polls to hit the threshold
    for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(30_000); // past the initial backoff
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId("isDegraded").textContent).toBe("true");
    });
  });

  it("emits price_degraded analytics event when entering degraded state", async () => {
    mockFetchXlmPrice.mockResolvedValue(failedResult());
    renderProvider();

    for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "price_degraded",
        expect.objectContaining({ consecutiveFailures: expect.any(Number) }),
      );
    });
  });

  it("recovers from degraded state when oracle returns a valid price", async () => {
    // Start with failures
    mockFetchXlmPrice.mockResolvedValue(failedResult());
    renderProvider();

    for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId("isDegraded").textContent).toBe("true");
    });

    // Now oracle recovers
    mockFetchXlmPrice.mockResolvedValue(freshResult());

    await act(async () => {
      jest.advanceTimersByTime(5 * 60_000 + 1000); // past max backoff
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("isDegraded").textContent).toBe("false");
      expect(screen.getByTestId("xlmUsd").textContent).toBe("0.12");
    });
  });

  it("emits price_recovered analytics event when recovering from degraded state", async () => {
    mockFetchXlmPrice.mockResolvedValue(failedResult());
    renderProvider();

    for (let i = 0; i <= MAX_CONSECUTIVE_FAILURES; i++) {
      await act(async () => {
        await Promise.resolve();
        jest.advanceTimersByTime(30_000);
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId("isDegraded").textContent).toBe("true");
    });

    mockFetchXlmPrice.mockResolvedValue(freshResult());

    await act(async () => {
      jest.advanceTimersByTime(5 * 60_000 + 1000);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(mockTrackEvent).toHaveBeenCalledWith(
        "price_recovered",
        expect.objectContaining({ source: "stellar-dex" }),
      );
    });
  });

  it("keeps the last known price while degraded (does not reset to null)", async () => {
    // First get a good price
    mockFetchXlmPrice.mockResolvedValue(freshResult(0.15));
    renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("xlmUsd").textContent).toBe("0.15");

    // Now start failing
    mockFetchXlmPrice.mockResolvedValue(failedResult());

    // Drive enough retries to reach degraded (MAX_CONSECUTIVE_FAILURES = 3)
    // Backoffs: 5s, 10s, 20s — advance generously to trigger each
    for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 1; i++) {
      await act(async () => {
        jest.advanceTimersByTime(30_000);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
    }

    await waitFor(() => {
      expect(screen.getByTestId("isDegraded").textContent).toBe("true");
    });

    // Price should remain at last known value
    expect(screen.getByTestId("xlmUsd").textContent).toBe("0.15");
  });
});

describe("PriceProvider — retry backoff", () => {
  it("uses backoff delay after a failure instead of normal interval", async () => {
    // Fail on the first call, succeed on subsequent
    mockFetchXlmPrice
      .mockResolvedValueOnce(failedResult())
      .mockResolvedValue(freshResult());

    renderProvider();

    // Flush initial (failed) fetch
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(1);

    // Advance only a little (less than POLL_INTERVAL) — should retry quickly due to backoff
    await act(async () => {
      jest.advanceTimersByTime(10_000); // 10s — well within initial 5s backoff range
      await Promise.resolve();
    });

    // Should have retried by now (initial backoff is 5s)
    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(2);
  });
});

describe("PriceProvider — cleanup", () => {
  it("cleans up timer and AbortController on unmount", async () => {
    const { unmount } = renderProvider();

    await act(async () => {
      await Promise.resolve();
    });

    // Should not throw on unmount
    expect(() => unmount()).not.toThrow();

    // Advancing timers after unmount should not cause more fetches
    const callCount = mockFetchXlmPrice.mock.calls.length;

    await act(async () => {
      jest.advanceTimersByTime(POLL_INTERVAL_MS * 2);
      await Promise.resolve();
    });

    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(callCount);
  });
});

describe("PriceProvider — multiple consumers (single poller)", () => {
  it("multiple consumers share the same price state", async () => {
    render(
      <PriceProvider>
        <PriceConsumer />
        <XlmPriceConsumer />
      </PriceProvider>,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("xlmUsd").textContent).toBe("0.12");
    expect(screen.getByTestId("xlmPrice").textContent).toBe("0.12");

    // Only one fetch despite two consumers
    expect(mockFetchXlmPrice).toHaveBeenCalledTimes(1);
  });
});
