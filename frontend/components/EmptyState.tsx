/**
 * components/EmptyState.tsx
 *
 * Shared, accessible empty-state presentation component. Consolidates the
 * inline "No X yet" / "No results" markup previously duplicated across
 * DonationFeed, the projects listing page, and the dashboard's donation
 * history and saved-projects tabs.
 *
 * Variants:
 *   - "empty"  — no data exists yet (default).
 *   - "search" — a search/filter query matched nothing.
 *   - "error"  — the data failed to load.
 *
 * Usage:
 *   <EmptyState
 *     variant="search"
 *     title="No projects match your filters"
 *     description="Try adjusting your search or filters."
 *     action={<button onClick={clearFilters}>Clear filters</button>}
 *   />
 */
import type { ReactNode } from "react";

export type EmptyStateVariant = "empty" | "search" | "error";

const DEFAULT_ICON: Record<EmptyStateVariant, string> = {
  empty: "🌱",
  search: "🔍",
  error: "⚠️",
};

export interface EmptyStateProps {
  /** Presentational variant; selects the default icon when `icon` is omitted. */
  variant?: EmptyStateVariant;
  /** Optional icon override. Defaults to a variant-appropriate emoji. */
  icon?: ReactNode;
  /** Required heading text. */
  title: string;
  /** Optional supporting copy shown below the title. */
  description?: string;
  /** Optional call-to-action, e.g. a <Link> or <button>. */
  action?: ReactNode;
  /** Heading level for the title, so callers can preserve document outline. */
  headingLevel?: "h2" | "h3";
  /** Additional classes merged onto the outer container (e.g. padding, py-*). */
  className?: string;
}

/** Shared accessible empty-state presentation block. */
export default function EmptyState({
  variant = "empty",
  icon,
  title,
  description,
  action,
  headingLevel = "h2",
  className = "",
}: EmptyStateProps) {
  const Heading = headingLevel;
  const displayIcon = icon ?? DEFAULT_ICON[variant];

  return (
    <div
      className={`card text-center py-16 ${className}`}
      data-testid="empty-state"
      data-variant={variant}
    >
      <p className="text-4xl mb-3" aria-hidden="true">
        {displayIcon}
      </p>
      <Heading className="font-display text-xl font-bold text-forest-900 mb-2">
        {title}
      </Heading>
      {description && (
        <p className="text-[#5a7a5a] dark:text-[#8aaa8a] text-sm font-body mb-4 max-w-md mx-auto">
          {description}
        </p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
