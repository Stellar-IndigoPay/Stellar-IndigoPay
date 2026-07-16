/**
 * components/admin/VerificationTable.tsx — Reusable verification requests table
 *
 * Renders a table of verification requests with columns for organization,
 * project, category, status, submission date, and action buttons.
 * Supports clickable rows that navigate to the detail view.
 */
import Link from "next/link";
import { formatDate, CATEGORY_ICONS } from "@/utils/format";
import type { VerificationRequestResponse } from "@/lib/api";

export type VerificationStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "rejected";

export const STATUS_LABELS: Record<VerificationStatus, string> = {
  pending: "Pending",
  in_review: "In Review",
  approved: "Approved",
  rejected: "Rejected",
};

export const STATUS_COLORS: Record<VerificationStatus, string> = {
  pending:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/40",
  in_review:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/40",
  approved:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40",
  rejected:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/40",
};

interface VerificationTableProps {
  requests: VerificationRequestResponse[];
  loading?: boolean;
  error?: string | null;
  /** Called when the "Start Review" quick action is clicked */
  onStartReview?: (id: string) => void;
  /** If true, hides the Actions column */
  hideActions?: boolean;
}

export default function VerificationTable({
  requests,
  loading = false,
  error = null,
  onStartReview,
  hideActions = false,
}: VerificationTableProps) {
  if (loading) {
    return (
      <div className="card p-0 overflow-hidden">
        <div className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex items-center gap-4 px-6 py-4 animate-pulse"
            >
              <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/4" />
              <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/5" />
              <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
              <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
              <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-semibold text-[var(--text)] font-body">
              Failed to load requests
            </p>
            <p className="text-sm text-[var(--text-secondary)] font-body">
              {error}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div className="card text-center py-16">
        <span className="text-5xl block mb-4">📭</span>
        <h3 className="font-display font-semibold text-lg text-[var(--text)] mb-1">
          No verification requests
        </h3>
        <p className="text-sm text-[var(--text-secondary)] font-body">
          When organizations submit through the apply form, their requests will
          appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D] shadow-sm">
      <table className="min-w-full divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
        <thead>
          <tr className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
            <th className="px-6 py-4 text-left">Organization</th>
            <th className="px-6 py-4 text-left">Project</th>
            <th className="px-6 py-4 text-left hidden md:table-cell">Category</th>
            <th className="px-6 py-4 text-left">Status</th>
            <th className="px-6 py-4 text-left hidden lg:table-cell">Submitted</th>
            {!hideActions && (
              <th className="px-6 py-4 text-right">Actions</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
          {requests.map((req) => {
            const status = req.status as VerificationStatus;
            const icon = CATEGORY_ICONS[req.projectCategory] || "🌿";

            return (
              <tr
                key={req.id}
                className="group hover:bg-[rgba(99,102,241,0.02)] dark:hover:bg-[rgba(129,140,248,0.03)] transition-colors"
              >
                <td className="px-6 py-4">
                  <Link
                    href={`/admin/verification/${req.id}`}
                    className="block"
                  >
                    <p className="text-sm font-semibold text-[var(--text)] font-body group-hover:text-[var(--primary)] transition-colors">
                      {req.organizationName}
                    </p>
                    {req.organizationCountry && (
                      <p className="text-xs text-[var(--muted)] font-body mt-0.5">
                        {req.organizationCountry}
                      </p>
                    )}
                  </Link>
                </td>
                <td className="px-6 py-4">
                  <Link
                    href={`/admin/verification/${req.id}`}
                    className="block"
                  >
                    <p className="text-sm font-medium text-[var(--text)] font-body">
                      {icon} {req.projectName}
                    </p>
                  </Link>
                </td>
                <td className="px-6 py-4 hidden md:table-cell">
                  <span className="text-sm text-[var(--text-secondary)] font-body">
                    {req.projectCategory}
                  </span>
                </td>
                <td className="px-6 py-4">
                  <span
                    className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full border ${
                      STATUS_COLORS[status] ||
                      STATUS_COLORS.pending
                    }`}
                  >
                    {STATUS_LABELS[status] || status}
                  </span>
                </td>
                <td className="px-6 py-4 hidden lg:table-cell">
                  <span className="text-sm text-[var(--text-secondary)] font-body">
                    {req.submittedAt ? formatDate(req.submittedAt) : "—"}
                  </span>
                </td>
                {!hideActions && (
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {onStartReview && status === "pending" && (
                        <button
                          onClick={(e) => {
                            e.preventDefault();
                            onStartReview(req.id);
                          }}
                          className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white hover:opacity-90 transition-all"
                        >
                          Start Review
                        </button>
                      )}
                      <Link
                        href={`/admin/verification/${req.id}`}
                        className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[var(--primary)] hover:bg-[rgba(99,102,241,0.06)] dark:hover:bg-[rgba(129,140,248,0.08)] transition-all"
                      >
                        View Details
                      </Link>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
