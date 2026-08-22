/**
 * components/PriceStaleIndicator.tsx
 *
 * Subtle inline indicator shown next to USD equivalents when the oracle price
 * is stale or degraded. Renders nothing when the price is fresh.
 *
 * Accessibility: uses aria-label so screen-reader users understand why "—" is
 * shown or what the clock icon means.
 */

interface PriceStaleIndicatorProps {
  isStale: boolean;
  isDegraded: boolean;
  priceAgeMs?: number | null;
  className?: string;
}

/**
 * Human-readable age label, e.g. "5 min old" or "2 hr old".
 */
function ageLabel(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min old`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hr old`;
}

/**
 * PriceStaleIndicator — shows a small clock badge when the price is stale
 * and nothing when the price is fresh. In degraded mode the badge is orange.
 */
export function PriceStaleIndicator({
  isStale,
  isDegraded,
  priceAgeMs,
  className = "",
}: PriceStaleIndicatorProps) {
  if (!isStale && !isDegraded) return null;

  const label = isDegraded
    ? "Price unavailable"
    : priceAgeMs != null
      ? `Price is ${ageLabel(priceAgeMs)}`
      : "Price may be outdated";

  const colorClass = isDegraded
    ? "text-orange-500 dark:text-orange-400"
    : "text-amber-500 dark:text-amber-400";

  return (
    <span
      className={`inline-flex items-center gap-0.5 ${colorClass} ${className}`}
      aria-label={label}
      title={label}
      data-testid="price-stale-indicator"
    >
      {/* Clock icon */}
      <svg
        className="w-3 h-3"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" />
        <polyline points="12 6 12 12 16 14" />
      </svg>
    </span>
  );
}
