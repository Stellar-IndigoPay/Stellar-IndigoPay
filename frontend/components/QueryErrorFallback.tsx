/**
 * components/QueryErrorFallback.tsx
 *
 * Reusable inline error UI for data-fetching failures. Renders a friendly,
 * accessible message and a retry control. Designed to be dropped into any
 * page that fetches data (React Query, manual `useEffect` + fetch, etc.) in
 * place of ad-hoc error markup.
 *
 * Responsibilities:
 *   - Show a user-facing message classified by `classifyError`.
 *   - Provide a single "Try Again" / "Retrying…" button that calls `onRetry`.
 *   - Disable the button and surface the in-flight retry state.
 *   - Keep the surrounding navigation shell (Navbar/Layout) mounted — this
 *     component only replaces the *page content*, never the app chrome.
 *
 * Accessibility:
 *   - `role="alert"` so screen readers announce the failure.
 *   - The retry button is a real <button> (keyboard focusable).
 */
import { classifyError } from "@/lib/queryErrors";

export interface QueryErrorFallbackProps {
  /** The error thrown by the failed request/fetch. */
  error: unknown;
  /** Called when the user presses the retry button. */
  onRetry: () => void;
  /** When true, the button is disabled and relabelled "Retrying…". */
  isRetrying?: boolean;
  /**
   * Number of retry attempts already made (0 = first failure). Used to render
   * "Retrying… (attempt X/3)". Omit to hide the counter.
   */
  retryCount?: number;
  /**
   * Maximum number of attempts shown in the counter label. Defaults to 3.
   */
  maxRetries?: number;
  /**
   * Optional heading override. Defaults to "Couldn't load this section".
   */
  title?: string;
  /**
   * Optional extra className for the outer wrapper (e.g. spacing/palette).
   */
  className?: string;
}

const RETRY_LIMIT = 3;

export function QueryErrorFallback({
  error,
  onRetry,
  isRetrying = false,
  retryCount,
  maxRetries = RETRY_LIMIT,
  title = "Couldn't load this section",
  className = "",
}: QueryErrorFallbackProps) {
  const classified = classifyError(error);

  const showCounter =
    typeof retryCount === "number" &&
    retryCount > 0 &&
    retryCount <= maxRetries;

  const buttonLabel = isRetrying
    ? showCounter
      ? `Retrying… (attempt ${retryCount}/${maxRetries})`
      : "Retrying…"
    : "Try Again";

  return (
    <div
      role="alert"
      aria-live="assertive"
      className={`card mx-auto my-8 max-w-lg text-center ${className}`}
    >
      <div className="text-4xl mb-3" aria-hidden>
        {"\ud83d\ude14"}
      </div>
      <h2 className="font-display text-xl font-semibold text-forest-900 mb-2">
        {title}
      </h2>
      <p className="text-sm text-[#5a7a5a] dark:text-[#8aaa8a] font-body mb-4">
        {classified.message}
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={isRetrying}
        aria-busy={isRetrying}
        data-testid="query-error-retry"
        className="btn-primary disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {buttonLabel}
      </button>
    </div>
  );
}

export default QueryErrorFallback;
