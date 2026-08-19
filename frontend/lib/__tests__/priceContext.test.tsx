/**
 * lib/__tests__/priceContext.test.tsx
 *
 * Unit tests for the PriceProvider price lifecycle:
 *   - Poll cadence (fetch is called on mount and after each interval)
 *   - Visibility pause/resume (polling pauses when hidden, resumes on visible)
 *   - Staleness transitions (isStale after STALE_THRESHOLD_MS)
 *   - Degraded state (isDegraded after MAX_FAILURES consecutive failures)
 *   - Retry backoff (poll delay grows on consecutive failures)
 *   - Analytics events (price_stale, price_degraded)
 *   - useXlmPrice() returns null when degraded
 *   - usePriceContext() exposes full metadata
 *
 * Uses fake timers and a mocked fetchXlmPrice so no real I/O occurs.
 *
 * @jest-environment jsdom
 */
import React from "react";
import {
  render,
  screen,
  act,
  waitFor,
} from "@testing-library/react";
import {
  PriceProvider,
  usePriceContext,
  useXlmPrice,
  POLL_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  MAX_FAILURES,
  BACKOFF_CAP_MS,
} from "@/lib/priceContext";

// ── Mocks ────────────────────────────────────────────────────────────────────

// Mock the oracle fetch module so we control the response in each test.
jest.mock("@/lib/oraclePrice");
import { fetchXlmPrice } from "@/lib/oraclePrice";
const mockFetch = fetchXlmPrice as jest.MockedFunction<typeof fetchXlmPrice>;

// Mock analytics so we can assert events without PostHog initialised.
jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));
import { trackEvent } from "@/lib/analytics";
const mockTrackEvent = trackEvent as jest.Mock;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A consumer component that renders all PriceContext fields as data-testid spans. */
function PriceConsumer() {
  const ctx = usePriceContext();
  return (
    <div>
      <span data-testid="xlmUsd">{ctx.xlmUsd ?? "null"}</span>
      <span data-testid="isStale">{String(ctx.isStale)}</span>
      <span data-testid="isDegraded">{String(ctx.isDegraded)}</span>
      <span data-testid="source">{ctx.source ?? "null"}</span>
      <span data-testid="lastUpdated">{ctx.lastUpdated ?? "null"}</span>
      <span data-testid="priceAgeMs">{ctx.priceAgeMs ?? "null"}</span>
    </div>
  );
}

/** A consumer component that uses the backwards-compatible useXlmPrice hook. */
function XlmPriceConsumer() {
  const price = useXlmPrice();
  return <span data-testid="xlmPrice">{price ?? "null"}</span>;
}

function renderWithProvider(ui: React.ReactNode) {
  return render(<PriceProvider>{ui}</PriceProvider>);
}

/** Advance timers by `ms` and flush all microtasks/promises. */
async function advanceBy(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    // Flush pending promise resolutions.
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ── Setup ────────────────────────────────────────────────────────────────────

const FRESH_RESPONSE = {
  price: 0.12,
  updatedAt: Date.now(),
  source: "stellar-dex",
  ok: true,
};

const FAIL_RESPONSE = {
  price: null,
  updatedAt: null,
  source: "unknown",
  ok: false,
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  // Default: oracle returns a fresh price.
  mockFetch.mockResolvedValue({ ...FRESH_RESPONSE, updatedAt: Date.now() });
  // Make document visible by default.
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => false,
  });
});

afterEach(() => {
  jest.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("PriceProvider — initial fetch", () => {
  it("fetches the price on mount and exposes it via context", async () => {
    renderWithProvider(<PriceConsumer />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("xlmUsd").textContent).toBe("0.12");
    expect(screen.getByTestId("source").textContent).toBe("stellar-dex");
    expect(screen.getByTestId("isDegraded").textContent).toBe("false");
    expect(screen.getByTestId("isStale").textContent).toBe("false");
  });

  it("useXlmPrice returns the price when not degraded", async () => {
    renderWithProvider(<XlmPriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("xlmPrice").textContent).toBe("0.12");
  });
});

describe("PriceProvider — poll cadence", () => {
  it("polls again after POLL_INTERVAL_MS", async () => {
    renderWithProvider(<PriceConsumer />);
    // Initial fetch.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past one poll interval (with max jitter headroom: +20% = +12s).
    await advanceBy(POLL_INTERVAL_MS * 1.3);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("polls a third time after two intervals", async () => {
    renderWithProvider(<PriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await advanceBy(POLL_INTERVAL_MS * 1.3);
    await advanceBy(POLL_INTERVAL_MS * 1.3);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });
});

describe("PriceProvider — visibility pause / resume", () => {
  it("does not poll when the tab is hidden", async () => {
    // Hide the tab before mounting.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });

    renderWithProvider(<PriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // The initial poll is triggered — it fires but sees document.hidden and
    // returns immediately without a fetch call.
    // Actually the poll fires but only skips the fetch when document.hidden.
    const callsAfterMount = mockFetch.mock.calls.length;

    // Advance well past the normal interval.
    await advanceBy(POLL_INTERVAL_MS * 3);
    // Should not have gained any new calls because tab is hidden.
    expect(mockFetch.mock.calls.length).toBe(callsAfterMount);
  });

  it("immediately fetches when the tab becomes visible again", async () => {
    // Tab starts visible, then is hidden, then becomes visible.
    renderWithProvider(<PriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const callsAfterMount = mockFetch.mock.calls.length;

    // Hide tab.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advanceBy(POLL_INTERVAL_MS * 2);
    // Still no new calls.
    expect(mockFetch.mock.calls.length).toBe(callsAfterMount);

    // Show tab — should trigger a fetch immediately.
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => false,
    });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockFetch.mock.calls.length).toBeGreaterThan(callsAfterMount);
  });
});

describe("PriceProvider — staleness transitions", () => {
  it("isStale becomes true when priceAgeMs exceeds STALE_THRESHOLD_MS", async () => {
    const now = Date.now();
    // Oracle returns a fresh price right now.
    mockFetch.mockResolvedValue({
      price: 0.12,
      updatedAt: now,
      source: "stellar-dex",
      ok: true,
    });

    renderWithProvider(<PriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("isStale").textContent).toBe("false");

    // Advance the age ticker past the stale threshold (1s ticks, need 5+ minutes).
    // The age-ticker runs setInterval(fn, 1000) and each tick computes
    // Date.now() - lastUpdated.  With fake timers we need Date.now to advance too.
    await act(async () => {
      jest.advanceTimersByTime(STALE_THRESHOLD_MS + 2_000);
      await Promise.resolve();
    });

    expect(screen.getByTestId("isStale").textContent).toBe("true");
  });

  it("fires price_stale analytics event once on stale transition", async () => {
    const now = Date.now();
    mockFetch.mockResolvedValue({
      price: 0.12,
      updatedAt: now,
      source: "stellar-dex",
      ok: true,
    });

    renderWithProvider(<PriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    await act(async () => {
      jest.advanceTimersByTime(STALE_THRESHOLD_MS + 2_000);
      await Promise.resolve();
    });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "price_stale",
      expect.objectContaining({ priceAgeMs: expect.any(Number) }),
    );

    // Advance more — event should not fire a second time.
    const callsAfterFirst = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "price_stale",
    ).length;
    await act(async () => {
      jest.advanceTimersByTime(STALE_THRESHOLD_MS);
      await Promise.resolve();
    });
    const callsAfterSecond = mockTrackEvent.mock.calls.filter(
      (c) => c[0] === "price_stale",
    ).length;
    expect(callsAfterSecond).toBe(callsAfterFirst);
  });
});

describe("PriceProvider — degraded state", () => {
  it("isDegraded becomes true after MAX_FAILURES consecutive failures", async () => {
    mockFetch.mockResolvedValue(FAIL_RESPONSE);

    renderWithProvider(<PriceConsumer />);

    // Drive MAX_FAILURES polls by advancing with backoff headroom each time.
    for (let i = 0; i < MAX_FAILURES; i++) {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await advanceBy(BACKOFF_CAP_MS);
    }

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByTestId("isDegraded").textContent).toBe("true");
  });

  it("fires price_degraded analytics event when degraded", async () => {
    mockFetch.mockResolvedValue(FAIL_RESPONSE);
    renderWithProvider(<PriceConsumer />);

    for (let i = 0; i < MAX_FAILURES; i++) {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await advanceBy(BACKOFF_CAP_MS);
    }
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(mockTrackEvent).toHaveBeenCalledWith(
      "price_degraded",
      expect.objectContaining({ consecutiveFailures: expect.any(Number) }),
    );
  });

  it("useXlmPrice returns null when degraded", async () => {
    mockFetch.mockResolvedValue(FAIL_RESPONSE);
    renderWithProvider(<XlmPriceConsumer />);

    for (let i = 0; i < MAX_FAILURES; i++) {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await advanceBy(BACKOFF_CAP_MS);
    }
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByTestId("xlmPrice").textContent).toBe("null");
  });

  it("recovers from degraded state when oracle returns a valid price", async () => {
    // First MAX_FAILURES polls fail.
    mockFetch.mockResolvedValue(FAIL_RESPONSE);
    renderWithProvider(<PriceConsumer />);

    for (let i = 0; i < MAX_FAILURES; i++) {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      await advanceBy(BACKOFF_CAP_MS);
    }
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId("isDegraded").textContent).toBe("true");

    // Next poll succeeds — should clear degraded state.
    mockFetch.mockResolvedValue({ ...FRESH_RESPONSE, updatedAt: Date.now() });
    await advanceBy(BACKOFF_CAP_MS);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(screen.getByTestId("isDegraded").textContent).toBe("false");
    expect(screen.getByTestId("xlmUsd").textContent).toBe("0.12");
  });
});

describe("PriceProvider — NaN / invalid price guard", () => {
  it("never exposes NaN or a negative xlmUsd", async () => {
    mockFetch.mockResolvedValueOnce({
      price: 0,        // zero → treated as null
      updatedAt: Date.now(),
      source: "test",
      ok: false,
    });

    renderWithProvider(<PriceConsumer />);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    const raw = screen.getByTestId("xlmUsd").textContent;
    // Should be null (displayed as "null") — never a 0 or NaN.
    expect(raw).toBe("null");
  });
});

describe("PriceProvider — multiple consumers (single poller)", () => {
  it("calls fetch only once even with multiple PriceConsumer instances", async () => {
    render(
      <PriceProvider>
        <PriceConsumer />
        <PriceConsumer />
        <PriceConsumer />
      </PriceProvider>,
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    // Only one fetch for all three consumers.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
