/**
 * lib/priceContext.tsx — Global XLM/USD price context with lifecycle management.
 *
 * Features:
 *  - Polls the oracle on a configurable interval (default 60 s) with ±20 % jitter
 *    so many tabs don't hammer the oracle simultaneously.
 *  - Pauses polling when the tab is hidden and resumes immediately on visibility
 *    regain (triggering a fresh fetch).
 *  - Tracks `updatedAt` / `source` / `priceAgeMs` from the oracle response and
 *    derives `isStale` (age > STALE_THRESHOLD_MS) and `isDegraded` (consecutive
 *    failures > MAX_FAILURES, meaning no fresh price can be obtained).
 *  - Retry-with-backoff on consecutive failures: waits longer between polls after
 *    each failure, capped at BACKOFF_CAP_MS.
 *  - Fires a single analytics event on the first stale transition per session.
 *  - The `useXlmPrice()` hook surface is backwards-compatible (still returns
 *    `number | null`).  Full metadata is available via `usePriceContext()`.
 */

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
  type ReactNode,
} from "react";
import { fetchXlmPrice } from "./oraclePrice";
import { trackEvent } from "./analytics";

// ── Configuration ───────────────────────────────────────────────────────────

/** How often to poll for a fresh price (milliseconds). */
export const POLL_INTERVAL_MS = 60_000;

/** Jitter factor: interval is multiplied by a random value in [1-JITTER, 1+JITTER]. */
const JITTER = 0.2;

/**
 * Price older than this is considered stale and the UI should show a warning.
 * 5 minutes matches the typical oracle TTL window.
 */
export const STALE_THRESHOLD_MS = 5 * 60_000;

/** After this many consecutive failures the state is promoted to `isDegraded`. */
export const MAX_FAILURES = 3;

/**
 * Maximum backoff between poll attempts when the oracle is failing.
 * The actual delay is `min(POLL_INTERVAL_MS * 2^failureCount, BACKOFF_CAP_MS)`.
 */
export const BACKOFF_CAP_MS = 10 * 60_000;

// ── Context shape ────────────────────────────────────────────────────────────

export interface PriceContextValue {
  /** Current XLM/USD price, or `null` when unavailable. */
  xlmUsd: number | null;
  /** Unix-millisecond timestamp of the oracle's `updatedAt` field. */
  lastUpdated: number | null;
  /** Age of the last known price in milliseconds (computed from `lastUpdated`). */
  priceAgeMs: number | null;
  /** Oracle source string, e.g. "stellar-dex". */
  source: string | null;
  /**
   * True when `priceAgeMs` exceeds {@link STALE_THRESHOLD_MS}.
   * A stale price is still shown but with a visual indicator.
   */
  isStale: boolean;
  /**
   * True when consecutive poll failures have exceeded {@link MAX_FAILURES}.
   * In the degraded state USD equivalents should not be shown.
   */
  isDegraded: boolean;
}

const DEFAULT_VALUE: PriceContextValue = {
  xlmUsd: null,
  lastUpdated: null,
  priceAgeMs: null,
  source: null,
  isStale: false,
  isDegraded: false,
};

const PriceContext = createContext<PriceContextValue>(DEFAULT_VALUE);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Apply ±JITTER to a base interval so many tabs don't poll in lock-step. */
function withJitter(baseMs: number): number {
  const factor = 1 + (Math.random() * 2 - 1) * JITTER;
  return Math.round(baseMs * factor);
}

/** Exponential back-off capped at BACKOFF_CAP_MS. */
function backoffDelay(failureCount: number): number {
  return Math.min(POLL_INTERVAL_MS * Math.pow(2, failureCount), BACKOFF_CAP_MS);
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function PriceProvider({ children }: { children: ReactNode }) {
  const [xlmUsd, setXlmUsd] = useState<number | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [priceAgeMs, setPriceAgeMs] = useState<number | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const [isDegraded, setIsDegraded] = useState(false);
  const [isStale, setIsStale] = useState(false);

  // Ref to track whether the stale-transition event has already been fired
  // this session (avoid repeated events on every poll tick).
  const staleFiredRef = useRef(false);

  // Keep a ref to the latest failure count so the poll closure always reads
  // the current value without needing to be recreated.
  const failureCountRef = useRef(0);

  // AbortController for the in-flight fetch; cancelled on cleanup or tab hide.
  const abortRef = useRef<AbortController | null>(null);

  // Timer handle for the next scheduled poll.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Age ticker ─────────────────────────────────────────────────────────────
  // Update `priceAgeMs` every second so consumers always have a live age value
  // without triggering a re-fetch.
  useEffect(() => {
    const tick = setInterval(() => {
      setLastUpdated((prev) => {
        if (prev === null) return prev;
        const age = Date.now() - prev;
        setPriceAgeMs(age);
        const nowStale = age > STALE_THRESHOLD_MS;
        setIsStale(nowStale);

        // Fire the stale analytics event once per session.
        if (nowStale && !staleFiredRef.current) {
          staleFiredRef.current = true;
          trackEvent("price_stale", { priceAgeMs: age });
        }
        return prev;
      });
    }, 1_000);
    return () => clearInterval(tick);
  }, []);

  // ── Fetch & schedule ───────────────────────────────────────────────────────
  const schedulePoll = useCallback(
    (delayMs: number) => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => poll(), delayMs);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const poll = useCallback(async () => {
    // Don't fetch when the tab is hidden — the visibility listener will
    // trigger a fresh fetch when the tab becomes visible again.
    if (typeof document !== "undefined" && document.hidden) return;

    // Cancel any previously in-flight request.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const result = await fetchXlmPrice(controller.signal);

    // Ignore results from a request that was aborted mid-flight.
    if (controller.signal.aborted) return;

    if (result.ok && result.price !== null) {
      // Successful fetch — reset failure count and update state.
      failureCountRef.current = 0;
      setConsecutiveFailures(0);
      setIsDegraded(false);
      setXlmUsd(result.price);

      // Prefer the oracle's own updatedAt timestamp; fall back to now.
      const ts = result.updatedAt ?? Date.now();
      setLastUpdated(ts);
      setPriceAgeMs(Date.now() - ts);
      setSource(result.source ?? null);

      const age = Date.now() - ts;
      const nowStale = age > STALE_THRESHOLD_MS;
      setIsStale(nowStale);
      if (nowStale && !staleFiredRef.current) {
        staleFiredRef.current = true;
        trackEvent("price_stale", { priceAgeMs: age });
      } else if (!nowStale) {
        // Price is fresh again — allow the event to fire on the next stale.
        staleFiredRef.current = false;
      }

      schedulePoll(withJitter(POLL_INTERVAL_MS));
    } else {
      // Failed fetch — back off and increment failure counter.
      const newCount = failureCountRef.current + 1;
      failureCountRef.current = newCount;
      setConsecutiveFailures(newCount);

      if (newCount >= MAX_FAILURES) {
        setIsDegraded(true);
        trackEvent("price_degraded", { consecutiveFailures: newCount });
      }

      schedulePoll(withJitter(backoffDelay(newCount)));
    }
  }, [schedulePoll]);

  // ── Visibility listener ────────────────────────────────────────────────────
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        // Tab is now hidden — cancel any pending poll; the in-flight request
        // can continue (we don't abort it) but we don't schedule the next one.
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      } else {
        // Tab became visible — fetch immediately then resume cadence.
        void poll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [poll]);

  // ── Initial fetch on mount ─────────────────────────────────────────────────
  useEffect(() => {
    void poll();
    return () => {
      // Cancel in-flight fetch and pending timer on unmount.
      abortRef.current?.abort();
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
    // poll is stable (useCallback with no deps that change).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const value: PriceContextValue = {
    xlmUsd,
    lastUpdated,
    priceAgeMs,
    source,
    isStale,
    isDegraded,
  };

  return (
    <PriceContext.Provider value={value}>
      {/* Emit a data attribute on the root element for observability tooling
          that reads DOM attributes (e.g. Datadog RUM session replay). */}
      <span
        data-price-state={
          isDegraded ? "degraded" : isStale ? "stale" : "fresh"
        }
        data-price-age-ms={priceAgeMs ?? ""}
        style={{ display: "none" }}
        aria-hidden="true"
      />
      {children}
    </PriceContext.Provider>
  );
}

// ── Hooks ────────────────────────────────────────────────────────────────────

/**
 * Returns the full price context value.
 * Use this when you need staleness metadata, not just the price.
 */
export function usePriceContext(): PriceContextValue {
  return useContext(PriceContext);
}

/**
 * Backwards-compatible hook returning only the XLM/USD price.
 * Returns `null` when the price is unavailable **or** when the context is
 * in a degraded state (so callers never render a stale/wrong USD value
 * without opting in to the full context).
 *
 * Note: callers that want to show the last known price even when stale should
 * use `usePriceContext().xlmUsd` directly.
 */
export function useXlmPrice(): number | null {
  const { xlmUsd, isDegraded } = useContext(PriceContext);
  // When degraded, pretend we have no price so callers fall back to "—".
  return isDegraded ? null : xlmUsd;
}
