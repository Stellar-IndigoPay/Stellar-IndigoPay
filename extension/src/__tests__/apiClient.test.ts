/**
 * Tests for extension/src/lib/apiClient.ts — retry-with-backoff,
 * error classification, and the per-host circuit breaker (issue #908).
 */

import {
  apiFetch,
  ApiClientError,
  classifyError,
  classifyHttpStatus,
  computeBackoffDelayMs,
  getBreakerSnapshot,
  hostOf,
  parseRetryAfterMs,
  subscribeBreakerEvents,
  __resetApiClientRuntimeStateForTests,
  type BreakerEvent,
} from "../lib/apiClient";

const API_URL = "https://api.stellar-indigopay.app/api/projects?search=x&limit=5";
const API_HOST = "api.stellar-indigopay.app";

// ── test helpers ──────────────────────────────────────────────────────

function mockResponse(
  status: number,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Response {
  const ok = status >= 200 && status < 300;
  const headers = opts.headers ?? {};
  return {
    ok,
    status,
    headers: {
      get: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
    },
    json: async () => opts.body ?? {},
  } as unknown as Response;
}

/** In-memory chrome.storage.local mock, installed fresh per test. */
function installStorageMock(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  (globalThis as any).chrome.storage.local.get = jest.fn(
    (keys: string[], callback: (result: Record<string, unknown>) => void) => {
      const result: Record<string, unknown> = {};
      keys.forEach((key) => {
        if (store.has(key)) result[key] = store.get(key);
      });
      callback(result);
    },
  );
  (globalThis as any).chrome.storage.local.set = jest.fn(
    (items: Record<string, unknown>, callback?: () => void) => {
      Object.entries(items).forEach(([key, value]) => store.set(key, value));
      if (callback) callback();
    },
  );
  return store;
}

/** Deterministic, controllable Date.now() for breaker cooldown timing. */
function installClock(initial = 1_700_000_000_000) {
  let current = initial;
  jest.spyOn(Date, "now").mockImplementation(() => current);
  return { advance: (ms: number) => (current += ms) };
}

const FAST_RETRY = { baseDelayMs: 1, maxDelayMs: 2, jitterRatio: 0, timeoutMs: 200 };

let originalFetch: typeof fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
});

beforeEach(() => {
  installStorageMock();
  __resetApiClientRuntimeStateForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

// ── classification ───────────────────────────────────────────────────

describe("classifyHttpStatus", () => {
  test("429 is retryable rate_limit", () => {
    expect(classifyHttpStatus(429)).toEqual({ retryable: true, category: "rate_limit" });
  });

  test("408 is retryable timeout", () => {
    expect(classifyHttpStatus(408)).toEqual({ retryable: true, category: "timeout" });
  });

  test.each([500, 502, 503, 504])("%d is retryable server error", (status) => {
    expect(classifyHttpStatus(status)).toEqual({ retryable: true, category: "server" });
  });

  test.each([400, 401, 403, 404, 422])("%d is non-retryable client error", (status) => {
    expect(classifyHttpStatus(status)).toEqual({ retryable: false, category: "client" });
  });
});

describe("classifyError", () => {
  test("AbortError is non-retryable aborted", () => {
    const err = new DOMException("cancelled", "AbortError");
    expect(classifyError(err)).toEqual({ retryable: false, category: "aborted" });
  });

  test("TimeoutError is retryable timeout", () => {
    const err = new DOMException("timed out", "TimeoutError");
    expect(classifyError(err)).toEqual({ retryable: true, category: "timeout" });
  });

  test("TypeError (network failure) is retryable network", () => {
    const err = new TypeError("Failed to fetch");
    expect(classifyError(err)).toEqual({ retryable: true, category: "network" });
  });

  test("unrecognized error defaults to retryable unknown", () => {
    expect(classifyError(new Error("boom"))).toEqual({ retryable: true, category: "unknown" });
  });
});

// ── backoff / jitter ─────────────────────────────────────────────────

describe("computeBackoffDelayMs", () => {
  const config = { baseDelayMs: 100, maxDelayMs: 10_000, jitterRatio: 0.5 };

  test("grows exponentially with attempt number (no jitter)", () => {
    const noJitter = { ...config, jitterRatio: 0 };
    expect(computeBackoffDelayMs(1, noJitter)).toBe(100);
    expect(computeBackoffDelayMs(2, noJitter)).toBe(200);
    expect(computeBackoffDelayMs(3, noJitter)).toBe(400);
    expect(computeBackoffDelayMs(4, noJitter)).toBe(800);
  });

  test("is capped at maxDelayMs", () => {
    const noJitter = { ...config, jitterRatio: 0, maxDelayMs: 500 };
    expect(computeBackoffDelayMs(10, noJitter)).toBe(500);
  });

  test("jitter=0 randomFn yields the low end of the jitter span", () => {
    // capped=100 at attempt 1, jitterRatio=0.5 -> span=50 -> floor=50
    expect(computeBackoffDelayMs(1, config, () => 0)).toBe(50);
  });

  test("jitter=1 randomFn yields the capped delay (upper bound)", () => {
    expect(computeBackoffDelayMs(1, config, () => 1)).toBe(100);
  });

  test("delay never exceeds maxDelayMs across many random samples", () => {
    for (let attempt = 1; attempt <= 8; attempt++) {
      for (let i = 0; i < 50; i++) {
        const delay = computeBackoffDelayMs(attempt, config, Math.random);
        expect(delay).toBeLessThanOrEqual(config.maxDelayMs);
        expect(delay).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

// ── Retry-After parsing ──────────────────────────────────────────────

describe("parseRetryAfterMs", () => {
  test("parses integer seconds", () => {
    expect(parseRetryAfterMs("120")).toBe(120_000);
  });

  test("parses an HTTP-date in the future", () => {
    const future = new Date(Date.now() + 5000).toUTCString();
    const ms = parseRetryAfterMs(future);
    expect(ms).not.toBeNull();
    expect(ms as number).toBeGreaterThan(0);
  });

  test("returns null for missing/invalid header", () => {
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs(undefined)).toBeNull();
    expect(parseRetryAfterMs("not-a-date-or-number")).toBeNull();
  });
});

// ── hostOf ────────────────────────────────────────────────────────────

describe("hostOf", () => {
  test("extracts host from a URL", () => {
    expect(hostOf("https://api.stellar-indigopay.app/api/projects?x=1")).toBe(
      "api.stellar-indigopay.app",
    );
  });

  test("falls back to 'unknown' for an invalid URL", () => {
    expect(hostOf("not a url")).toBe("unknown");
  });
});

// ── apiFetch: retry behavior & bounded attempts ─────────────────────

describe("apiFetch retry behavior", () => {
  test("retries a retryable failure and returns the eventual success", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(503))
      .mockResolvedValueOnce(mockResponse(200));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await apiFetch(API_URL, {}, { retry: { ...FAST_RETRY, maxAttempts: 3 } });

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("bounds retries to maxAttempts and never exceeds the budget", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await apiFetch(API_URL, {}, { retry: { ...FAST_RETRY, maxAttempts: 3 } });

    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  test("does not retry a non-retryable client error", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(404));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await apiFetch(API_URL, {}, { retry: { ...FAST_RETRY, maxAttempts: 3 } });

    expect(res.status).toBe(404);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("retries network errors and throws ApiClientError after exhausting attempts", async () => {
    const mockFetch = jest.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    await expect(
      apiFetch(API_URL, {}, { retry: { ...FAST_RETRY, maxAttempts: 2 } }),
    ).rejects.toMatchObject({
      name: "ApiClientError",
      category: "network",
      attempts: 2,
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

// ── apiFetch: Retry-After honoring ──────────────────────────────────

describe("apiFetch Retry-After honoring", () => {
  test("honors a short Retry-After inline and retries", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(429, { headers: { "Retry-After": "0" } }))
      .mockResolvedValueOnce(mockResponse(200));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await apiFetch(
      API_URL,
      {},
      { retry: { ...FAST_RETRY, maxAttempts: 3 }, breaker: { failureThreshold: 10 } },
    );

    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("a long Retry-After trips the breaker instead of blocking inline", async () => {
    const clock = installClock();
    const mockFetch = jest
      .fn()
      .mockResolvedValue(mockResponse(429, { headers: { "Retry-After": "3600" } }));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const res = await apiFetch(
      API_URL,
      {},
      { retry: { ...FAST_RETRY, maxAttempts: 3, maxInlineRetryAfterMs: 10_000 } },
    );

    // The 429 is handed back immediately — no inline retry consumed.
    expect(res.status).toBe(429);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("open");
    // Capped by maxCooldownMs (default 5 min) even though the header asked for 1h.
    expect(snapshot.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
    expect(snapshot.retryAfterMs).toBeGreaterThan(0);

    // Subsequent calls short-circuit without hitting the network again.
    clock.advance(1);
    await expect(apiFetch(API_URL)).rejects.toMatchObject({ breakerOpen: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

// ── circuit breaker state machine ───────────────────────────────────

describe("circuit breaker state machine", () => {
  test("trips OPEN after the failure threshold and short-circuits further calls", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 2, cooldownMs: 30_000 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("open");

    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ).rejects.toMatchObject({ breakerOpen: true, category: "breaker_open" });
    // No additional network call once the breaker is open.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("concurrent requests share breaker state (all short-circuit once open)", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 1 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    // First call trips the breaker (threshold=1).
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Now fire several concurrent calls against the already-open breaker.
    const results = await Promise.allSettled([
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ]);

    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") {
        expect(result.reason).toMatchObject({ breakerOpen: true });
      }
    }
    // Shared state meant none of the concurrent calls touched the network.
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("cooldown elapses -> HALF_OPEN trial -> success closes the breaker", async () => {
    const clock = installClock();
    const mockFetch = jest.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 1, cooldownMs: 30_000, halfOpenSuccessThreshold: 1 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    const events: BreakerEvent[] = [];
    const unsubscribe = subscribeBreakerEvents((e) => events.push(e));

    mockFetch.mockResolvedValueOnce(mockResponse(500));
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect((await getBreakerSnapshot(API_HOST)).state).toBe("open");

    // Cooldown hasn't elapsed yet — still short-circuits.
    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ).rejects.toMatchObject({ breakerOpen: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past the cooldown; the next call is allowed through as a trial.
    clock.advance(30_001);
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const res = await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    expect((await getBreakerSnapshot(API_HOST)).state).toBe("closed");
    expect(events.map((e) => e.type)).toEqual([
      "breaker_open",
      "breaker_half_open",
      "breaker_closed",
    ]);
    unsubscribe();
  });

  test("HALF_OPEN trial failure reopens the breaker", async () => {
    const clock = installClock();
    const mockFetch = jest.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 1, cooldownMs: 30_000, halfOpenSuccessThreshold: 1 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    mockFetch.mockResolvedValueOnce(mockResponse(500));
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });

    clock.advance(30_001);
    mockFetch.mockResolvedValueOnce(mockResponse(500)); // trial also fails
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });

    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("open");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // Still within the new cooldown window — short-circuits again.
    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ).rejects.toMatchObject({ breakerOpen: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test("breaker state persists across a simulated service worker restart", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 1, cooldownMs: 30_000 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect((await getBreakerSnapshot(API_HOST)).state).toBe("open");

    // Simulate the MV3 service worker being suspended and restarted: the
    // in-memory cache is gone, but chrome.storage.local persists.
    __resetApiClientRuntimeStateForTests();

    const rehydrated = await getBreakerSnapshot(API_HOST);
    expect(rehydrated.state).toBe("open");
    expect(rehydrated.consecutiveFailures).toBe(1);

    // And apiFetch still honors the persisted open state without a network call.
    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ).rejects.toMatchObject({ breakerOpen: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test("concurrent failures don't lose updates to consecutiveFailures (no undercounting race)", async () => {
    // Regression test: acquireBreakerPermission/recordBreakerFailure each do
    // a read-modify-write against the same per-host record. Without
    // serializing those read-modify-writes, N concurrent failing calls can
    // all read consecutiveFailures=0 and all write back 1, undercounting
    // the threshold and leaving the breaker CLOSED when it should trip.
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 5, cooldownMs: 30_000 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
      ),
    );

    // Every concurrent call actually reached the network (breaker was
    // CLOSED for all of them at dispatch time).
    expect(mockFetch).toHaveBeenCalledTimes(5);
    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }

    // All 5 failures must be counted — none lost to a lost-update race —
    // so the breaker trips exactly at the configured threshold.
    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("open");
    expect(snapshot.consecutiveFailures).toBe(5);
  });

  test("a stale success from a request admitted before the breaker opened doesn't resurrect it", async () => {
    // Regression test: request A is admitted while CLOSED (trial: false)
    // but its fetch is slow. Before it resolves, a concurrent request B
    // (also admitted while CLOSED) fails and trips the breaker OPEN. A's
    // late success must not reset that OPEN record back to CLOSED — its
    // permission was granted under an earlier generation of the breaker
    // record, which is gone once B moved it to a new one.
    let resolveA!: (res: Response) => void;
    const deferredA = new Promise<Response>((resolve) => {
      resolveA = resolve;
    });
    const mockFetch = jest
      .fn()
      .mockImplementationOnce(() => deferredA)
      .mockImplementationOnce(async () => mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 1, cooldownMs: 30_000 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    const requestA = apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });

    // Let A acquire its (CLOSED, generation 0) permission and reach its
    // pending fetch before starting B.
    for (let i = 0; i < 50 && mockFetch.mock.calls.length < 1; i++) {
      await Promise.resolve();
    }

    const resB = await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(resB.status).toBe(500);
    expect((await getBreakerSnapshot(API_HOST)).state).toBe("open");

    resolveA(mockResponse(200));
    const resA = await requestA;
    expect(resA.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // A's stale success (generation 0) must be a no-op against the record
    // B already moved to generation 1 — the breaker stays OPEN.
    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("open");
  });

  test("a successful call resets the failure counter", async () => {
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(mockResponse(500))
      .mockResolvedValueOnce(mockResponse(200));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = { failureThreshold: 3 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });

    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("closed");
    expect(snapshot.consecutiveFailures).toBe(0);
  });
});

// ── cancellation ──────────────────────────────────────────────────────

describe("apiFetch cancellation", () => {
  test("an already-aborted signal short-circuits without calling fetch", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(200));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();

    await expect(
      apiFetch(API_URL, {}, { signal: controller.signal }),
    ).rejects.toMatchObject({ category: "aborted", retryable: false });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test("cancellation does not count as a breaker failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue(mockResponse(200));
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const controller = new AbortController();
    controller.abort();
    await expect(apiFetch(API_URL, {}, { signal: controller.signal })).rejects.toBeInstanceOf(
      ApiClientError,
    );

    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("closed");
    expect(snapshot.consecutiveFailures).toBe(0);
  });

  test("cancelling a HALF_OPEN trial releases its slot instead of wedging the breaker open forever", async () => {
    const clock = installClock();
    const mockFetch = jest.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = {
      failureThreshold: 1,
      cooldownMs: 30_000,
      halfOpenMaxConcurrent: 1,
      halfOpenSuccessThreshold: 1,
    };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    // Trip the breaker, then advance past its cooldown so the next call is
    // eligible to become a HALF_OPEN trial.
    mockFetch.mockResolvedValueOnce(mockResponse(500));
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    clock.advance(30_001);

    // This call acquires the (only) trial slot, then is cancelled before
    // the fetch ever completes — the pre-fetch abort check in the retry
    // loop fires immediately since the signal is already aborted.
    const controller = new AbortController();
    controller.abort();
    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig, signal: controller.signal }),
    ).rejects.toMatchObject({ category: "aborted" });
    // The cancelled trial must not have touched the network or counted as
    // a breaker outcome.
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Without releasing the slot, halfOpenInFlight would still be 1 here
    // (== halfOpenMaxConcurrent) and every subsequent call would
    // short-circuit as breaker_open forever, with no time-based recovery.
    // A normal (non-cancelled) call must be able to claim the trial slot.
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const res = await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(res.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect((await getBreakerSnapshot(API_HOST)).state).toBe("closed");
  });

  test("an abort that isn't the external signal (e.g. our own recognized-but-unmatched abort) also releases the trial slot", async () => {
    const clock = installClock();
    const mockFetch = jest.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = {
      failureThreshold: 1,
      cooldownMs: 30_000,
      halfOpenMaxConcurrent: 1,
      halfOpenSuccessThreshold: 1,
    };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    mockFetch.mockResolvedValueOnce(mockResponse(500));
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    clock.advance(30_001);

    // fetch() itself rejects with an AbortError that isn't our timeout
    // controller and isn't the (absent) external signal.
    mockFetch.mockRejectedValueOnce(new DOMException("aborted elsewhere", "AbortError"));
    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ).rejects.toMatchObject({ category: "aborted" });

    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const res = await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(res.ok).toBe(true);
  });

  test("a HALF_OPEN trial whose outcome is never recorded (e.g. a hard worker kill) self-heals once stale, even without an explicit cancellation", async () => {
    const clock = installClock();
    const store = installStorageMock();
    const mockFetch = jest.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    const breakerConfig = {
      failureThreshold: 1,
      cooldownMs: 30_000,
      halfOpenMaxConcurrent: 1,
      halfOpenSuccessThreshold: 1,
    };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    mockFetch.mockResolvedValueOnce(mockResponse(500));
    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    clock.advance(30_001);

    // Directly poke storage into a half_open state whose trial was never
    // resolved — simulating a service worker that was killed mid-request,
    // after acquireBreakerPermission() persisted the trial slot but before
    // any outcome was ever recorded. __resetApiClientRuntimeStateForTests
    // simulates the worker restart (in-memory cache gone, storage intact).
    const key = `indigopay:apiClient:v1:breaker:${API_HOST}`;
    const stuck = store.get(key) as Record<string, unknown>;
    store.set(key, { ...stuck, state: "half_open", halfOpenInFlight: 1, updatedAt: Date.now() });
    __resetApiClientRuntimeStateForTests();

    // Immediately after the "restart", the trial is still fresh — blocked.
    await expect(
      apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig }),
    ).rejects.toMatchObject({ breakerOpen: true });
    expect(mockFetch).toHaveBeenCalledTimes(1); // only the original trip

    // Once the stuck trial is older than the cooldown, it's treated as
    // expired and a fresh trial is allowed through.
    clock.advance(30_001);
    mockFetch.mockResolvedValueOnce(mockResponse(200));
    const res = await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    expect(res.ok).toBe(true);
    expect((await getBreakerSnapshot(API_HOST)).state).toBe("closed");
  });
});

// ── breaker snapshot / custom cooldown ──────────────────────────────────

describe("getBreakerSnapshot with a custom breaker cooldownMs", () => {
  test("retryAfterMs reflects a custom cooldownMs, not the global default", async () => {
    const clock = installClock();
    const mockFetch = jest.fn().mockResolvedValueOnce(mockResponse(500));
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    // Deliberately different from DEFAULT_CIRCUIT_BREAKER_CONFIG.cooldownMs
    // (30_000) so a snapshot computed from the default would be wrong.
    const breakerConfig = { failureThreshold: 1, cooldownMs: 90_000 };
    const retryConfig = { ...FAST_RETRY, maxAttempts: 1 };

    await apiFetch(API_URL, {}, { retry: retryConfig, breaker: breakerConfig });
    clock.advance(10_000);

    const snapshot = await getBreakerSnapshot(API_HOST);
    expect(snapshot.state).toBe("open");
    expect(snapshot.retryAfterMs).toBe(80_000); // 90_000 - 10_000, not 20_000
  });
});
