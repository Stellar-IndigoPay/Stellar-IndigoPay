/**
 * components/admin/AuditLogTable.tsx — Reusable audit log table
 *
 * Renders admin audit log entries in a responsive table with:
 * - Filter bar (actor, action, target type, date range, full-text search)
 * - Paginated rows with expandable metadata
 * - CSV export button
 * - Loading, empty, and error states
 */
import { useState, useCallback } from "react";
import { formatDate, shortenAddress } from "@/utils/format";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  actor: string;
  action: string;
  target_type: string | null;
  target_id: string | null;
  metadata: Record<string, unknown> | string | null;
  ip_address: string | null;
  created_at: string;
  prev_hash?: string | null;
  row_hash?: string | null;
}

export interface AuditLogFilters {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  dateFrom: string;
  dateTo: string;
  search: string;
}

export const DEFAULT_FILTERS: AuditLogFilters = {
  actor: "",
  action: "",
  targetType: "",
  targetId: "",
  dateFrom: "",
  dateTo: "",
  search: "",
};

export interface AuditLogTableProps {
  /** Audit log entries for the current page. */
  logs: AuditLogEntry[];
  /** Total matching entries (for pagination display). */
  total: number;
  /** Current page number (1-indexed). */
  page: number;
  /** Number of entries per page. */
  pageSize: number;
  /** Whether data is loading. */
  loading: boolean;
  /** Error message to display. */
  error?: string | null;
  /** Current filter state. */
  filters: AuditLogFilters;
  /** Called when any filter value changes. */
  onFilterChange: (filters: AuditLogFilters) => void;
  /** Called when the page changes. */
  onPageChange: (page: number) => void;
  /** Called when the export CSV button is clicked. */
  onExport: () => void;
  /** Whether the export is in progress. */
  exporting?: boolean;
  /** Distinct action values for the action dropdown. */
  distinctActions?: string[];
  /** Optional className override. */
  className?: string;
}

// ── Action group categories for display ──────────────────────────────────────

const ACTION_CATEGORIES: Record<string, string> = {
  "verification.pending": "Verification",
  "verification.in_review": "Verification",
  "verification.approved": "Verification",
  "verification.rejected": "Verification",
  "project.register": "Projects",
  "project.update": "Projects",
  "project.deactivate": "Projects",
  "admin.login": "Admin",
  "admin.logout": "Admin",
  "admin.token_refresh": "Admin",
  "match.create": "Matches",
  "match.update": "Matches",
  "match.delete": "Matches",
  "webhook.replay": "Webhooks",
  "webhook.delete": "Webhooks",
};

function categorizeAction(action: string): string {
  return ACTION_CATEGORIES[action] || action.split(".")[0] || "Other";
}

const CATEGORY_ORDER = [
  "Verification",
  "Projects",
  "Admin",
  "Matches",
  "Webhooks",
  "Other",
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseMetadata(
  meta: Record<string, unknown> | string | null,
): Record<string, unknown> {
  if (!meta) return {};
  if (typeof meta === "string") {
    try {
      return JSON.parse(meta);
    } catch {
      return { raw: meta };
    }
  }
  return meta;
}

function metadataPreview(meta: Record<string, unknown>): string {
  const entries = Object.entries(meta).filter(
    ([k]) => !["method", "path", "statusCode"].includes(k),
  );
  if (entries.length === 0) return JSON.stringify(meta).slice(0, 80);
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(", ");
}

function actionColor(action: string): string {
  if (action.includes("reject") || action.includes("deactivate"))
    return "text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/30";
  if (action.includes("approve") || action.includes("login"))
    return "text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800/30";
  if (action.includes("register") || action.includes("create"))
    return "text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800/30";
  return "text-[var(--text-secondary)] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)]";
}

// ── Filter row component ──────────────────────────────────────────────────────

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  options,
}: {
  label: string;
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  type?: "text" | "date";
  options?: { value: string; label: string }[];
}) {
  const id = `filter-${label.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="flex flex-col gap-1">
      <label
        htmlFor={id}
        className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body"
      >
        {label}
      </label>
      {options ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="px-2.5 py-1.5 rounded-lg text-xs font-body border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D] text-[var(--text)] focus:outline-none focus:ring-2 focus:ring-[rgba(99,102,241,0.25)] dark:focus:ring-[rgba(129,140,248,0.30)]"
        >
          <option value="">All</option>
          {options.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="px-2.5 py-1.5 rounded-lg text-xs font-body border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D] text-[var(--text)] placeholder:text-[var(--muted)] focus:outline-none focus:ring-2 focus:ring-[rgba(99,102,241,0.25)] dark:focus:ring-[rgba(129,140,248,0.30)]"
        />
      )}
    </div>
  );
}

// ── Metadata popover ──────────────────────────────────────────────────────────

function MetadataPopover({
  metadata,
}: {
  metadata: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const entries = Object.entries(metadata);
  const hasContent = entries.length > 0;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="text-xs font-semibold text-[var(--primary)] hover:underline font-body disabled:opacity-40"
        disabled={!hasContent}
        aria-label={open ? "Close metadata" : "View metadata"}
      >
        {open ? "Hide" : "Details"}
      </button>
      {open && hasContent && (
        <div className="absolute right-0 top-6 z-50 w-72 p-3 rounded-xl bg-white dark:bg-[#1E1B4B] border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] shadow-xl text-xs font-body animate-scale-in origin-top-right">
          <div className="max-h-48 overflow-y-auto space-y-1.5">
            {entries.map(([k, v]) => {
              const val =
                typeof v === "object" ? JSON.stringify(v, null, 1) : String(v);
              return (
                <div key={k} className="flex flex-col gap-0.5">
                  <span className="font-semibold text-[var(--text-secondary)] uppercase tracking-wider text-[10px]">
                    {k}
                  </span>
                  <span className="text-[var(--text)] break-all leading-snug font-mono text-[11px]">
                    {val.length > 120 ? val.slice(0, 120) + "…" : val}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function AuditLogTable({
  logs,
  total,
  page,
  pageSize,
  loading,
  error,
  filters,
  onFilterChange,
  onPageChange,
  onExport,
  exporting = false,
  distinctActions = [],
  className = "",
}: AuditLogTableProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  // Build action dropdown options from distinct actions
  const actionOptions = distinctActions
    .filter(Boolean)
    .map((action) => ({
      value: action,
      label: `${action} (${categorizeAction(action)})`,
    }))
    .sort((a, b) => {
      const catOrderA = CATEGORY_ORDER.indexOf(categorizeAction(a.value));
      const catOrderB = CATEGORY_ORDER.indexOf(categorizeAction(b.value));
      if (catOrderA !== catOrderB) return catOrderA - catOrderB;
      return a.value.localeCompare(b.value);
    });

  const targetTypeOptions = [
    { value: "verification_request", label: "Verification Request" },
    { value: "project", label: "Project" },
    { value: "admin", label: "Admin" },
    { value: "match", label: "Match" },
    { value: "webhook", label: "Webhook" },
    { value: "document", label: "Document" },
  ];

  const updateFilter = useCallback(
    (key: keyof AuditLogFilters, value: string) => {
      onFilterChange({ ...filters, [key]: value });
    },
    [filters, onFilterChange],
  );

  const clearFilters = useCallback(() => {
    onFilterChange(DEFAULT_FILTERS);
  }, [onFilterChange]);

  const hasActiveFilters = Object.values(filters).some((v) => v !== "");

  // ── Loading state ─────────────────────────────────────────────────
  if (loading) {
    return (
      <div className={`card p-0 overflow-hidden ${className}`}>
        <div className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-6 py-4 animate-pulse"
            >
              <div className="h-3 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
              <div className="h-3 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/5" />
              <div className="h-3 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/4" />
              <div className="h-3 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
              <div className="h-3 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────
  if (error) {
    return (
      <div className={`card ${className}`}>
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-semibold text-[var(--text)] font-body">
              Failed to load audit log
            </p>
            <p className="text-sm text-[var(--text-secondary)] font-body">
              {error}
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`}>
      {/* ── Filter bar ──────────────────────────────────────────────── */}
      <div className="card">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
            Filters
          </h2>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              className="text-xs font-semibold text-[var(--primary)] hover:underline font-body"
            >
              Clear all
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
          <FilterInput
            label="Actor"
            value={filters.actor}
            onChange={(v) => updateFilter("actor", v)}
            placeholder="Wallet address"
          />
          <FilterInput
            label="Action"
            value={filters.action}
            onChange={(v) => updateFilter("action", v)}
            options={actionOptions}
          />
          <FilterInput
            label="Target"
            value={filters.targetType}
            onChange={(v) => updateFilter("targetType", v)}
            options={targetTypeOptions}
          />
          <FilterInput
            label="Search"
            value={filters.search}
            onChange={(v) => updateFilter("search", v)}
            placeholder="Full-text search"
          />
          <FilterInput
            label="From"
            value={filters.dateFrom}
            onChange={(v) => updateFilter("dateFrom", v)}
            type="date"
          />
          <FilterInput
            label="To"
            value={filters.dateTo}
            onChange={(v) => updateFilter("dateTo", v)}
            type="date"
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
              &nbsp;
            </label>
            <button
              onClick={onExport}
              disabled={exporting || logs.length === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white hover:opacity-90 transition-all disabled:opacity-40 disabled:cursor-not-allowed font-body flex items-center gap-1.5"
              aria-label="Export audit log as CSV"
            >
              {exporting ? (
                <>
                  <span className="w-3 h-3 rounded-full border-2 border-white/30 border-t-white animate-spin" />
                  Exporting…
                </>
              ) : (
                <>
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                    aria-hidden="true"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                    />
                  </svg>
                  Export CSV
                </>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* ── Table ──────────────────────────────────────────────────── */}
      <div className="overflow-x-auto rounded-2xl border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D] shadow-sm">
        {logs.length === 0 ? (
          <div className="text-center py-16">
            <span className="text-5xl block mb-4">📋</span>
            <h3 className="font-display font-semibold text-lg text-[var(--text)] mb-1">
              No audit log entries
            </h3>
            <p className="text-sm text-[var(--text-secondary)] font-body max-w-sm mx-auto">
              {hasActiveFilters
                ? "No entries match the current filters. Try adjusting your search criteria."
                : "Audit log entries will appear here as admin actions are recorded."}
            </p>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="mt-4 text-sm font-semibold text-[var(--primary)] hover:underline font-body"
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <table className="min-w-full divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                <th className="px-4 py-3 text-left">Timestamp</th>
                <th className="px-4 py-3 text-left">Actor</th>
                <th className="px-4 py-3 text-left">Action</th>
                <th className="px-4 py-3 text-left hidden md:table-cell">
                  Target
                </th>
                <th className="px-4 py-3 text-left hidden lg:table-cell">IP</th>
                <th className="px-4 py-3 text-right">Metadata</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
              {logs.map((entry) => {
                const parsedMeta = parseMetadata(entry.metadata);
                const preview = metadataPreview(parsedMeta);

                return (
                  <tr
                    key={entry.id}
                    className="group hover:bg-[rgba(99,102,241,0.02)] dark:hover:bg-[rgba(129,140,248,0.03)] transition-colors"
                  >
                    {/* Timestamp */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className="text-xs text-[var(--text-secondary)] font-body"
                        title={entry.created_at}
                      >
                        {formatDate(entry.created_at)}
                      </span>
                    </td>

                    {/* Actor */}
                    <td className="px-4 py-3 whitespace-nowrap max-w-[120px]">
                      <span
                        className="text-xs font-mono text-[var(--text)]"
                        title={entry.actor}
                      >
                        {shortenAddress(entry.actor, 4)}
                      </span>
                    </td>

                    {/* Action */}
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span
                        className={`inline-flex text-[11px] font-semibold px-2 py-0.5 rounded-full border ${actionColor(entry.action)}`}
                      >
                        {entry.action}
                      </span>
                    </td>

                    {/* Target */}
                    <td className="px-4 py-3 hidden md:table-cell max-w-[160px]">
                      <div className="flex flex-col gap-0.5">
                        {entry.target_type && (
                          <span className="text-[11px] text-[var(--text-secondary)] font-body uppercase tracking-wider">
                            {entry.target_type}
                          </span>
                        )}
                        {entry.target_id && (
                          <span
                            className="text-xs font-mono text-[var(--text)] truncate"
                            title={entry.target_id}
                          >
                            {shortenAddress(entry.target_id, 6)}
                          </span>
                        )}
                        {!entry.target_type && !entry.target_id && (
                          <span className="text-xs text-[var(--muted)] font-body">
                            —
                          </span>
                        )}
                      </div>
                    </td>

                    {/* IP Address */}
                    <td className="px-4 py-3 hidden lg:table-cell whitespace-nowrap">
                      <span className="text-xs font-mono text-[var(--text-secondary)]">
                        {entry.ip_address || "—"}
                      </span>
                    </td>

                    {/* Metadata */}
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-[11px] text-[var(--muted)] font-body hidden xl:inline max-w-[140px] truncate">
                          {preview}
                        </span>
                        <MetadataPopover metadata={parsedMeta} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Pagination ─────────────────────────────────────────────── */}
      {total > 0 && (
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <p className="text-sm text-[var(--text-secondary)] font-body">
            Showing{" "}
            <span className="font-semibold text-[var(--text)]">
              {from}–{to}
            </span>{" "}
            of{" "}
            <span className="font-semibold text-[var(--text)]">
              {total}
            </span>{" "}
            entries
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] disabled:opacity-40 transition-all font-body"
            >
              ← Previous
            </button>
            <div className="flex items-center gap-1">
              {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                const pageNum = i + 1;
                const isActive = pageNum === page;
                return (
                  <button
                    key={pageNum}
                    onClick={() => onPageChange(pageNum)}
                    className={`w-8 h-8 rounded-lg text-xs font-semibold transition-all font-body ${
                      isActive
                        ? "bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white shadow-md"
                        : "text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)]"
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
            </div>
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] disabled:opacity-40 transition-all font-body"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
