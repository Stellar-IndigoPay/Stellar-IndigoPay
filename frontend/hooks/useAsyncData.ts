/**
 * hooks/useAsyncData.ts
 *
 * Standardized data-fetching hook for pages that load data with a plain async
 * function (the app's existing pattern: `useEffect` + `fetch` helpers in
 * `lib/api`). It centralises the three states every data page needs —
 * loading, error, success — plus a retry flow with an attempt counter, so
 * individual pages don't re-implement retry logic.
 *
 * This is deliberately framework-agnostic (no React Query dependency) but its
 * return shape mirrors React Query's `useQuery` so migrating a page to React
 * Query later is mechanical: `data` / `error` / `isLoading` / `refetch`.
 *
 * The navigation shell (Navbar/Layout/Header/Sidebar) is owned by `_app.tsx`
 * and is never touched here — this hook only governs *page content* state.
 *
 * @example
 *   const { data, error, isLoading, isError, refetch, isRetrying, retryCount } =
 *     useAsyncData(() => fetchProfile(publicKey), { deps: [publicKey] });
 */
import { useCallback, useEffect, useRef, useState } from "react";

/** Return shape of `useAsyncData`, modelled on React Query's `useQuery`. */
export interface AsyncDataState<T> {
  /** Successfully resolved value, or `null` before first load / on error. */
  data: T | null;
  /** The latest error, or `null` while loading / after success. */
  error: unknown;
  /** True until the first successful or failed fetch completes. */
  isLoading: boolean;
  /** True after a fetch rejects. */
  isError: boolean;
  /** True while a (re)fetch is in flight. */
  isRetrying: boolean;
  /** Number of retry attempts made (0 = first failure). */
  retryCount: number;
  /**
   * Re-run the async function. Clears the error and bumps the retry counter
   * once a retry has already failed once. Safe to call from a button handler.
   */
  refetch: () => void;
}

export interface UseAsyncDataOptions {
  /**
   * Dependency list controlling when the fetch re-runs automatically. Same
   * semantics as the deps array of `useEffect`.
   */
  deps?: ReadonlyArray<unknown>;
  /**
   * When false, the hook will not auto-fetch on mount / dep change. Useful
   * for pages that need a user action (e.g. wallet connect) before loading.
   * Defaults to true.
   */
  enabled?: boolean;
  /**
   * Maximum number of retry attempts tracked for the counter. Defaults to 3.
   */
  maxRetries?: number;
}

const DEFAULT_MAX_RETRIES = 3;

export function useAsyncData<T>(
  fetcher: () => Promise<T>,
  options: UseAsyncDataOptions = {},
): AsyncDataState<T> {
  const {
    deps = [],
    enabled = true,
    maxRetries = DEFAULT_MAX_RETRIES,
  } = options;

  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState<boolean>(enabled);
  const [isRetrying, setIsRetrying] = useState<boolean>(false);
  const [retryCount, setRetryCount] = useState<number>(0);

  // Keep the latest fetcher in a ref so the auto-fetch effect doesn't need
  // `fetcher` in its deps (which would otherwise re-run every render).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Auto-fetch on mount and whenever `deps` change (and enabled).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!enabled) {
      setIsLoading(false);
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((err) => {
        if (!cancelled) setError(err);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, ...deps]);

  // Retry: re-run the fetcher and increment the attempt counter (capped) so
  // the fallback can show "Retrying… (attempt X/3)". Does not reset `data` so
  // a previously loaded view can stay visible if desired.
  const refetch = useCallback(() => {
    if (isRetrying) return;
    setRetryCount((c) => Math.min(c + 1, maxRetries));
    setIsRetrying(true);
    setError(null);
    fetcherRef
      .current()
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((err) => {
        setError(err);
      })
      .finally(() => {
        setIsRetrying(false);
      });
  }, [isRetrying, maxRetries]);

  return {
    data,
    error,
    isLoading,
    isError: error !== null,
    isRetrying,
    retryCount,
    refetch,
  };
}

export default useAsyncData;
