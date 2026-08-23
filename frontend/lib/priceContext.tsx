/**
 * lib/priceContext.tsx — Global XLM/USD price context with lifecycle management.
 *
 * Features:
 * - Polls fetchXlmPrice on a configurable interval (default 60 s) with
 *   ±10% random jitter to avoid thundering-herd on multi-tab sessions.
 * - Pauses polling when the tab is hidden (visibilitychange) and resumes
 *   immediately on visibility regain so long-running background tabs do not
 *   spam the oracle.
 * - Retry-with-backoff on consecutive failures (capped at MAX_BACKOFF_MS).
 * - Exposes `isStale` when the price age exceeds STALE_THRESHOLD_MS.
 * - Exposes `isDegraded` after MAX_CONSECUTIVE_FAILURES consecutive failures
 *   so the UI can fall back to "—" instead of a wrong number.
 * - Emits analytics events on stale/degraded transitions for observability.
 *
 * Context shape additions are fully additive; the existing `useXlmPrice()`
 * hook signature is unchanged for backward compatibility.
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

// ── Configuration ──────────────────────────────────────────────────────────────

/** Base polling interval in milliseconds. */
export const POLL_INTERVAL_MS = 60_000;

/**
 * Jitter factor: each poll fires at POLL_INTERVAL_MS ± (POLL_INTERVAL_MS * JITTER_FACTOR).
 * 0.1 = ±10 %.
 */
const JITTER_FACTOR = 0.1;

/**
 * Age threshold (ms) after which a cached price is considered stale.
 * Derived from the oracle-side `updatedAt` timestamp so client clock skew
 * does not cause false positives. Falls back to fetchedAt when updatedAt is
 * missing.
 */
export const STALE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

/**
 * Number of consecutive fetch failures before we enter the "degraded" state
 * and the UI replaces USD figures with "—".
 */
export const MAX_CONSECUTIVE_FAILURES = 3;

/** Maximum back-off delay between retries (ms). */
const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes

/** Initial back-off delay (ms). Doubles on each consecutive failure. */
const INITIAL_BACKOFF_MS = 5_000;

// ── Context types ─────────────────────────────────────────────────────────────

export interface PriceContextValue {
  /** Current XLM/USD price, or `null` when unavailable. */
  xlmUsd: number | null;
  /**
   * `true` when the price is older than {@link STALE_THRESHOLD_MS}.
   * The price is still shown but with a warning indicator.
   */
  isStale: boolean;
  /**
   * `true` after {@link MAX_CONSECUTIVE_FAILURES} consecutive fetch failures.
   * USD equivalents should be replaced with "—" in this state.
   */
  isDegraded: boolean;
  /** Age of the current price in milliseconds (computed from oracle updatedAt). */
  priceAgeMs: number | null;
  /** Oracle-side epoch-ms at which the price was last updated. */
  updatedAt: number | null;
  /** Oracle data source identifier. */
  source: string | null;
}

const defaultContext: PriceContextValue = {
  xlmUsd: null,
  isStale: false,
  isDegraded: false,
  priceAgeMs: null,
  updatedAt: null,
  source: null,
};

const PriceContext = createContext<PriceContextValue>(defaultContext);

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns a jittered interval: base ± (base × JITTER_FACTOR). */
function jitteredInterval(base: number): number {
  const delta = base * JITTER_FACTOR;
  return base + (Math.random() * 2 - 1) * delta;
}

/** Exponential back-off delay, capped at MAX_BACKOFF_MS. */
function backoffDelay(consecutiveFailures: number): number {
  const delay = INITIAL_BACKOFF_MS * Math.pow(2, consecutiveFailures - 1);
  return Math.min(delay, MAX_BACKOFF_MS);
}

/** Compute price age from the oracle timestamp, falling back to fetchedAt. */
function computePriceAgeMs(
  updatedAt: number | null,
  fetchedAt: number,
): number {
  const reference = updatedAt ?? fetchedAt;
  return Date.now() - reference;
}

// ── Provider ──────────────────────────────────────────────────────────────────

export function PriceProvider({ children }: { children: ReactNode }) {
  const [priceState, setPriceState] = useState<PriceContextValue>(defaultContext);

  // Track staleness/degraded transitions to emit analytics only on change.
  const wasStaleRef = useRef(false);
  const wasDegradedRef = useRef(false);

  // Consecutive failure count for backoff calculation.
  const consecutiveFailuresRef = useRef(0);

  // AbortController for the in-flight fetch.
  const abortControllerRef = useRef<AbortController | null>(null);

  // Scheduled timer id for the next poll.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Whether polling is paused (tab hidden).
  const isPausedRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedulePoll = useCallback(
    (delayMs: number) => {
      clearTimer();
      timerRef.current = setTimeout(() => {
        void runPoll(); // eslint-disable-line @typescript-eslint/no-use-before-define
      }, delayMs);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const runPoll = useCallback(async () => {
    if (isPausedRef.current) return;

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const result = await fetchXlmPrice(controller.signal);

    if (controller.signal.aborted) return;

    if (result.price !== null) {
      // Successful fetch — reset failure counter.
      consecutiveFailuresRef.current = 0;

      const ageMs = computePriceAgeMs(result.updatedAt, result.fetchedAt);
      const isStale = ageMs > STALE_THRESHOLD_MS;
      const isDegraded = false;

      setPriceState((prev) => {
        // Emit stale-transition analytics only when the state changes.
        if (isStale && !wasStaleRef.current) {
          wasStaleRef.current = true;
          trackEvent("price_stale", {
            priceAgeMs: ageMs,
            source: result.source,
          });
        } else if (!isStale) {
          wasStaleRef.current = false;
        }
        if (prev.isDegraded && !isDegraded) {
          wasDegradedRef.current = false;
          trackEvent("price_recovered", { source: result.source });
        }

        return {
          xlmUsd: result.price,
          isStale,
          isDegraded,
          priceAgeMs: ageMs,
          updatedAt: result.updatedAt,
          source: result.source,
        };
      });

      schedulePoll(jitteredInterval(POLL_INTERVAL_MS));
    } else {
      // Failed fetch.
      consecutiveFailuresRef.current += 1;
      const failures = consecutiveFailuresRef.current;
      const isDegraded = failures >= MAX_CONSECUTIVE_FAILURES;

      setPriceState((prev) => {
        if (isDegraded && !wasDegradedRef.current) {
          wasDegradedRef.current = true;
          trackEvent("price_degraded", { consecutiveFailures: failures });
        }

        // Keep the last known price and timestamps; only flip flags.
        const ageMs =
          prev.updatedAt !== null || prev.priceAgeMs !== null
            ? computePriceAgeMs(prev.updatedAt, Date.now())
            : null;
        return {
          ...prev,
          isStale: ageMs !== null ? ageMs > STALE_THRESHOLD_MS : prev.isStale,
          isDegraded,
          priceAgeMs: ageMs,
        };
      });

      // Retry with exponential backoff instead of the normal poll interval.
      schedulePoll(backoffDelay(failures));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedulePoll]);

  useEffect(() => {
    // Start initial fetch immediately.
    void runPoll();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        isPausedRef.current = true;
        clearTimer();
        abortControllerRef.current?.abort();
      } else {
        // Tab became visible — resume polling right away.
        isPausedRef.current = false;
        void runPoll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      clearTimer();
      abortControllerRef.current?.abort();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <PriceContext.Provider value={priceState}>
      {children}
    </PriceContext.Provider>
  );
}

// ── Consumer hooks ─────────────────────────────────────────────────────────────

/**
 * Returns the raw XLM/USD price (or `null`).
 * Backward-compatible with existing consumers.
 */
export function useXlmPrice(): number | null {
  return useContext(PriceContext).xlmUsd;
}

/**
 * Returns the full price lifecycle context including staleness and degraded state.
 */
export function usePriceContext(): PriceContextValue {
  return useContext(PriceContext);
}
