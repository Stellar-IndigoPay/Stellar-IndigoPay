/**
 * lib/__tests__/errorReporter.test.ts
 *
 * Unit tests for `lib/errorReporter.ts` — the fire-and-forget capture
 * sink used by ErrorBoundary and any imperative try/catch in screens.
 *
 * Behavior contract under test:
 *   - captureException logs to console.error for dev visibility
 *   - captureException POSTs to `${API_URL}/api/errors/report`
 *   - captureException also forwards to Sentry if @sentry/react-native
 *     is resolvable
 *   - Network/timeout failures are silent (resolved as `false`, never
 *     throw); backend status >=400 also resolves as `false`
 *   - init() never throws even when Sentry is not present
 */

// Hoisted jest.mock so the require cache is populated for the
// `@sentry/react-native` lookup inside errorReporter BEFORE the
// errorReporter module has a chance to require it. Using `virtual: true`
// keeps the test stable even when the package is not installed.
jest.mock(
  "@sentry/react-native",
  () => ({
    init: jest.fn(),
    captureException: jest.fn(),
  }),
  { virtual: true },
);

const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;

import { init, captureException } from "../errorReporter";
import * as sentryMock from "@sentry/react-native";
import { act } from "@testing-library/react-native";

beforeEach(() => {
  fetchMock.mockReset();
  (sentryMock.init as jest.Mock).mockReset();
  (sentryMock.captureException as jest.Mock).mockReset();
});

describe("errorReporter", () => {
  test("captureException posts a JSON payload to the backend", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });

    const err = new Error("boom");
    const ok = await captureException(err, { componentStack: "stack-trace" });

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/api\/errors\/report$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.message).toBe("boom");
    expect(body.stack).toBeDefined();
    expect(body.componentStack).toBe("stack-trace");
    expect(body.platform).toBeDefined();
  });

  test("captureException returns false on backend non-2xx", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });
    (sentryMock.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    const ok = await captureException(new Error("boom"));
    expect(ok).toBe(false);
  });

  test("captureException swallows network errors silently", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    (sentryMock.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });
    const ok = await captureException(new Error("boom"));
    expect(ok).toBe(false);
  });

  test("captureException does NOT throw when fetch is slow / aborted", async () => {
    // The wrapper schedules a 3s setTimeout to call
    // controller.abort() on the supplied signal. We drive the test
    // with fake timers so we do NOT actually wait three real
    // seconds. The fetch mock rejects when the abort signal fires
    // (which happens after the advanceTimersByTime below), and the
    // wrapper resolves `false` to signal "report not delivered".
    fetchMock.mockImplementationOnce(
      (_url: unknown, init: { signal?: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    (sentryMock.captureException as jest.Mock).mockImplementationOnce(() => {
      throw new Error("sentry down");
    });

    jest.useFakeTimers();
    try {
      // Kick off the capture; do NOT await yet — we need to advance
      // the clock first so the abort fires while the fetch is in
      // flight. We capture the returned promise to await after the
      // advance.
      const pending = captureException(new Error("boom"));
      jest.advanceTimersByTime(3000);
      // After the advance, the abort signal has fired and the
      // fetch's promise has rejected; captureException's outer
      // promise has now resolved to `false`.
      const result = await pending;
      expect(result).toBe(false);
    } finally {
      jest.useRealTimers();
    }

    // The wrapper must have called fetch exactly once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }, 10000);

  test("captureException forwards to Sentry exactly once with the error", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await captureException(new Error("boom"), { componentStack: "trace" });

    // The hoisted `jest.mock('@sentry/react-native', ..., { virtual: true })`
    // populates the require cache before the wrapper's
    // `require('@sentry/react-native')` runs, so we expect the strict
    // single forward. A regression that drops the forwarding would
    // make this assertion fail rather than silently pass.
    expect(sentryMock.captureException).toHaveBeenCalledTimes(1);
    expect(sentryMock.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ extra: expect.any(Object) }),
    );
  });

  test("init swallows when @sentry/react-native is absent", async () => {
    // Force Sentry init to throw; the wrapper must not propagate.
    (sentryMock.init as jest.Mock).mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await expect(init()).resolves.toBeUndefined();
  });
});
