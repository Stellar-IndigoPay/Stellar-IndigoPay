/**
 * components/StalePriceIndicator.tsx
 *
 * A small inline chip that signals whether the displayed XLM/USD price is
 * fresh, stale, or unavailable (degraded).
 *
 * Usage:
 *   <StalePriceIndicator />   — auto-reads from PriceContext
 *
 * The component renders nothing when the price is fresh and the oracle is
 * healthy, keeping the UI clean for the happy path.
 */
import { usePriceContext } from "@/lib/priceContext";

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

interface StalePriceIndicatorProps {
  /** Additional Tailwind classes to merge onto the outer element. */
  className?: string;
}

/**
 * Renders a subtle amber chip when the price is stale and a red chip when
 * the oracle is degraded.  Renders nothing when fresh.
 *
 * Accessibility: the container carries `role="status"` and `aria-live="polite"`
 * so screen-reader users are informed of staleness transitions without
 * interrupting the current flow.
 */
export default function StalePriceIndicator({
  className = "",
}: StalePriceIndicatorProps) {
  const { isStale, isDegraded, priceAgeMs } = usePriceContext();

  if (!isStale && !isDegraded) return null;

  if (isDegraded) {
    return (
      <span
        role="status"
        aria-live="polite"
        data-testid="price-indicator-degraded"
        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold font-body
          bg-red-50 dark:bg-red-950/30 text-red-600 dark:text-red-400
          border border-red-200 dark:border-red-800 ${className}`}
      >
        <span aria-hidden="true">⚠</span>
        Price unavailable
      </span>
    );
  }

  // isStale === true
  const ageLabel = priceAgeMs !== null ? formatAge(priceAgeMs) : null;

  return (
    <span
      role="status"
      aria-live="polite"
      data-testid="price-indicator-stale"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold font-body
        bg-amber-50 dark:bg-amber-950/30 text-amber-700 dark:text-amber-400
        border border-amber-200 dark:border-amber-800 ${className}`}
    >
      <span aria-hidden="true">⏱</span>
      Price{ageLabel ? ` updated ${ageLabel}` : " may be outdated"}
    </span>
  );
}
