/**
 * pages/admin/verification/[id].tsx — Verification Request Detail View
 *
 * Shows the full submitted data for a single verification request,
 * including supporting documents. Admins can transition the request
 * status (pending → in_review → approved/rejected) and add reviewer
 * notes.
 *
 * API endpoints:
 *   - GET    /api/v1/verification-requests/:id
 *   - PATCH  /api/v1/verification-requests/:id/status
 */
import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import AdminLayout from "@/components/admin/AdminLayout";
import {
  STATUS_LABELS,
  STATUS_COLORS,
  type VerificationStatus,
} from "@/components/admin/VerificationTable";
import {
  adminFetch,
  isAdminAuthenticated,
} from "@/lib/adminAuth";
import { formatDate, CATEGORY_ICONS } from "@/utils/format";
import type { VerificationRequestResponse } from "@/lib/api";

// Valid transitions from the backend (backend/src/routes/verification.js)
const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["in_review", "rejected"],
  in_review: ["approved", "rejected", "pending"],
  approved: [],
  rejected: ["pending"],
};

const TRANSITION_BUTTONS: Record<
  string,
  Array<{
    status: string;
    label: string;
    variant: "primary" | "danger" | "secondary";
    icon: string;
  }>
> = {
  pending: [
    {
      status: "in_review",
      label: "Start Review",
      variant: "primary",
      icon: "🔍",
    },
  ],
  in_review: [
    { status: "approved", label: "Approve", variant: "primary", icon: "✅" },
    { status: "rejected", label: "Reject", variant: "danger", icon: "❌" },
    {
      status: "pending",
      label: "Move Back to Pending",
      variant: "secondary",
      icon: "↩️",
    },
  ],
  approved: [
    {
      status: "pending",
      label: "Reopen",
      variant: "secondary",
      icon: "↩️",
    },
  ],
  rejected: [
    {
      status: "pending",
      label: "Reopen",
      variant: "secondary",
      icon: "↩️",
    },
  ],
};

export default function VerificationDetailPage() {
  const router = useRouter();
  const { id } = router.query;

  const [request, setRequest] = useState<VerificationRequestResponse | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [reviewerNotes, setReviewerNotes] = useState("");
  const [showNotesField, setShowNotesField] = useState(false);

  // Check auth
  useEffect(() => {
    if (!isAdminAuthenticated()) {
      router.replace("/admin/login");
    }
  }, [router]);

  // Fetch request detail
  useEffect(() => {
    if (!id || typeof id !== "string") return;

    setLoading(true);
    setError(null);

    adminFetch(`/api/v1/verification-requests/${id}`)
      .then(async (res) => {
        if (!res.ok) {
          if (res.status === 404) throw new Error("Verification request not found");
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body?.error || body?.message || `Request failed (${res.status})`,
          );
        }
        const body = await res.json();
        setRequest(body.data);
        setReviewerNotes(body.data.reviewerNotes || "");
      })
      .catch((err: unknown) => {
        const msg =
          err instanceof Error ? err.message : "Failed to load request";
        setError(msg);
      })
      .finally(() => setLoading(false));
  }, [id]);

  // Handle status transition
  const handleTransition = async (newStatus: string) => {
    if (!request || !id || typeof id !== "string") return;

    setActionLoading(true);
    setActionError(null);

    try {
      const payload: Record<string, unknown> = { status: newStatus };
      if (reviewerNotes.trim()) {
        payload.reviewerNotes = reviewerNotes.trim();
      }

      const res = await adminFetch(
        `/api/v1/verification-requests/${id}/status`,
        {
          method: "PATCH",
          body: JSON.stringify(payload),
        },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error || body?.message || "Failed to update status",
        );
      }

      const body = await res.json();
      setRequest(body.data);
      setReviewerNotes(body.data.reviewerNotes || "");
      setShowNotesField(false);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to update status";
      setActionError(msg);
    } finally {
      setActionLoading(false);
    }
  };

  const transitionButtons = request
    ? TRANSITION_BUTTONS[request.status] || []
    : [];

  // Loading state
  if (loading) {
    return (
      <>
        <Head>
          <title>Verification Detail — Admin — Stellar-IndigoPay</title>
        </Head>
        <AdminLayout>
          <div className="flex flex-col items-center justify-center py-20">
            <div className="w-8 h-8 rounded-full border-2 border-[var(--primary)] border-t-transparent animate-spin mb-4" />
            <p className="text-sm text-[var(--muted)] font-body">
              Loading request…
            </p>
          </div>
        </AdminLayout>
      </>
    );
  }

  // Error state
  if (error || !request) {
    return (
      <>
        <Head>
          <title>Verification Detail — Admin — Stellar-IndigoPay</title>
        </Head>
        <AdminLayout>
          <div className="max-w-lg mx-auto text-center py-20">
            <span className="text-5xl block mb-4">🔍</span>
            <h2 className="font-display text-xl font-bold text-[var(--text)] mb-2">
              {error || "Request not found"}
            </h2>
            <p className="text-sm text-[var(--text-secondary)] font-body mb-6">
              The verification request you're looking for may have been removed
              or you may not have access to it.
            </p>
            <Link
              href="/admin/verification"
              className="btn-primary text-sm inline-flex"
            >
              ← Back to Queue
            </Link>
          </div>
        </AdminLayout>
      </>
    );
  }

  const status = request.status as VerificationStatus;
  const icon = CATEGORY_ICONS[request.projectCategory] || "🌿";
  const docCount = request.supportingDocuments?.length || 0;

  return (
    <>
      <Head>
        <title>
          {request.organizationName} — Verification — Stellar-IndigoPay
        </title>
      </Head>
      <AdminLayout>
        {/* Breadcrumb */}
        <div className="mb-6">
          <Link
            href="/admin/verification"
            className="text-sm text-[var(--text-secondary)] hover:text-[var(--primary)] font-body transition-colors inline-flex items-center gap-1"
          >
            ← Back to Queue
          </Link>
        </div>

        {/* Header card */}
        <div className="card mb-6">
          <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-2xl">{icon}</span>
                <h1 className="font-display text-2xl font-bold text-[var(--text)] truncate">
                  {request.organizationName}
                </h1>
              </div>
              <p className="text-lg text-[var(--text-secondary)] font-body">
                {request.projectName}
              </p>
              <div className="flex flex-wrap items-center gap-3 mt-3">
                <span
                  className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full border ${
                    STATUS_COLORS[status] || STATUS_COLORS.pending
                  }`}
                >
                  {STATUS_LABELS[status] || status}
                </span>
                <span className="text-xs text-[var(--muted)] font-body">
                  Submitted {request.submittedAt ? formatDate(request.submittedAt) : "—"}
                </span>
                {request.reviewedAt && (
                  <span className="text-xs text-[var(--muted)] font-body">
                    Reviewed {formatDate(request.reviewedAt)}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Action error */}
        {actionError && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 mb-6">
            <span className="text-red-500 text-sm mt-0.5">⚠️</span>
            <p className="text-sm text-red-700 dark:text-red-300 font-body">
              {actionError}
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Main details column */}
          <div className="lg:col-span-2 space-y-6">
            {/* Organization details */}
            <div className="card">
              <h2 className="font-display text-lg font-bold text-[var(--text)] mb-4">
                Organization Details
              </h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <DetailItem
                  label="Organization Name"
                  value={request.organizationName}
                />
                <DetailItem
                  label="Organization Website"
                  value={request.organizationWebsite}
                  isLink
                />
                <DetailItem
                  label="Country"
                  value={request.organizationCountry}
                />
                <DetailItem
                  label="Contact Email"
                  value={request.contactEmail}
                  isLink
                  href={`mailto:${request.contactEmail}`}
                />
                <DetailItem
                  label="Wallet Address"
                  value={request.walletAddress}
                  mono
                />
              </dl>
            </div>

            {/* Project details */}
            <div className="card">
              <h2 className="font-display text-lg font-bold text-[var(--text)] mb-4">
                Project Details
              </h2>
              <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                <DetailItem
                  label="Project Name"
                  value={request.projectName}
                />
                <DetailItem
                  label="Category"
                  value={`${icon} ${request.projectCategory}`}
                />
                <DetailItem
                  label="Location"
                  value={request.projectLocation}
                />
                <DetailItem
                  label="CO₂ per XLM"
                  value={`${request.co2PerXLM} kg`}
                />
                <DetailItem
                  label="Expected Annual CO₂"
                  value={
                    request.expectedAnnualTonnesCO2
                      ? `${request.expectedAnnualTonnesCO2} tonnes`
                      : "Not provided"
                  }
                />
                <DetailItem
                  label="Storage Backend"
                  value={request.storageBackend || "local"}
                />
              </dl>
              {request.projectDescription && (
                <div className="mt-4 pt-4 border-t border-[var(--border-light)]">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
                    Description
                  </p>
                  <p className="text-sm text-[var(--text-secondary)] font-body leading-relaxed whitespace-pre-wrap">
                    {request.projectDescription}
                  </p>
                </div>
              )}
              {request.notes && (
                <div className="mt-4 pt-4 border-t border-[var(--border-light)]">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)] mb-2">
                    Applicant Notes
                  </p>
                  <p className="text-sm text-[var(--text-secondary)] font-body leading-relaxed whitespace-pre-wrap">
                    {request.notes}
                  </p>
                </div>
              )}
            </div>

            {/* Supporting documents */}
            <div className="card">
              <h2 className="font-display text-lg font-bold text-[var(--text)] mb-4">
                Supporting Documents
                <span className="ml-2 text-sm font-normal text-[var(--muted)]">
                  ({docCount})
                </span>
              </h2>
              {docCount === 0 ? (
                <p className="text-sm text-[var(--muted)] font-body">
                  No supporting documents uploaded.
                </p>
              ) : (
                <div className="space-y-2">
                  {request.supportingDocuments.map(
                    (doc: { name?: string; url?: string; size?: number }, i: number) => (
                      <a
                        key={i}
                        href={doc.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex items-center gap-3 p-3 rounded-xl bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-all border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] group"
                      >
                        <span className="text-lg">📄</span>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-[var(--text)] font-body truncate group-hover:text-[var(--primary)] transition-colors">
                            {doc.name || `Document ${i + 1}`}
                          </p>
                          {doc.size && (
                            <p className="text-xs text-[var(--muted)] font-body">
                              {(doc.size / 1024).toFixed(1)} KB
                            </p>
                          )}
                        </div>
                        <svg
                          className="w-4 h-4 text-[var(--muted)] group-hover:text-[var(--primary)] transition-colors flex-shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth={2}
                        >
                          <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                      </a>
                    ),
                  )}
                </div>
              )}
            </div>

            {/* Reviewer notes — display-only, edit via action sidebar */}
            <div className="card">
              <h2 className="font-display text-lg font-bold text-[var(--text)] mb-4">
                Reviewer Notes
              </h2>
              {request.reviewerNotes ? (
                <div>
                  <p className="text-sm text-[var(--text-secondary)] font-body leading-relaxed whitespace-pre-wrap">
                    {request.reviewerNotes}
                  </p>
                  {request.reviewedBy && (
                    <p className="text-xs text-[var(--muted)] font-body mt-3">
                      Reviewed by: {request.reviewedBy}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-sm text-[var(--muted)] font-body italic">
                  No reviewer notes yet.
                </p>
              )}
            </div>
          </div>

          {/* Sidebar: actions */}
          <div className="space-y-6">
            {/* Status transitions */}
            <div className="card">
              <h2 className="font-display text-lg font-bold text-[var(--text)] mb-4">
                Actions
              </h2>
              {transitionButtons.length === 0 ? (
                <p className="text-sm text-[var(--muted)] font-body">
                  No transitions available for{" "}
                  <strong>{STATUS_LABELS[status] || status}</strong> requests.
                </p>
              ) : (
                <div className="space-y-3">
                  {transitionButtons.map((btn) => (
                    <button
                      key={btn.status}
                      onClick={() => handleTransition(btn.status)}
                      disabled={actionLoading}
                      className={`w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-50 ${
                        btn.variant === "primary"
                          ? "bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white hover:shadow-lg"
                          : btn.variant === "danger"
                            ? "bg-gradient-to-r from-[#F43F5E] to-[#FB7185] text-white hover:shadow-lg"
                            : "border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.06)] dark:hover:bg-[rgba(129,140,248,0.08)]"
                      }`}
                    >
                      {actionLoading ? (
                        <span className="w-4 h-4 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      ) : (
                        <span>{btn.icon}</span>
                      )}
                      {btn.label}
                    </button>
                  ))}
                </div>
              )}

              {/* Notes textarea — shown before transition actions */}
              <div className="mt-4 pt-4 border-t border-[var(--border-light)]">
                <label className="flex items-center gap-2 cursor-pointer mb-3">
                  <input
                    type="checkbox"
                    checked={showNotesField}
                    onChange={() => setShowNotesField(!showNotesField)}
                    className="rounded border-[var(--border)] text-[var(--primary)] focus:ring-[var(--primary)]"
                  />
                  <span className="text-xs font-medium text-[var(--text-secondary)] font-body">
                    {request.reviewerNotes ? "Edit notes with action" : "Add notes with action"}
                  </span>
                </label>
                {showNotesField && (
                  <textarea
                    value={reviewerNotes}
                    onChange={(e) => setReviewerNotes(e.target.value)}
                    className="input-field min-h-[100px] resize-y mb-3"
                    placeholder="Enter your review notes here… (max 2000 characters)"
                    maxLength={2000}
                    disabled={actionLoading}
                  />
                )}
              </div>
            </div>

            {/* Info card */}
            <div className="card">
              <h2 className="font-display text-lg font-bold text-[var(--text)] mb-4">
                Info
              </h2>
              <dl className="space-y-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
                    Request ID
                  </p>
                  <p className="text-xs font-mono text-[var(--text)] break-all">
                    {request.id}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
                    Submitted
                  </p>
                  <p className="text-xs text-[var(--text-secondary)] font-body">
                    {request.submittedAt
                      ? formatDate(request.submittedAt)
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
                    Status
                  </p>
                  <span
                    className={`inline-flex text-xs font-semibold px-2 py-0.5 rounded-full border mt-0.5 ${
                      STATUS_COLORS[status] || STATUS_COLORS.pending
                    }`}
                  >
                    {STATUS_LABELS[status] || status}
                  </span>
                </div>
                {request.reviewedBy && (
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
                      Reviewed By
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] font-body">
                      {request.reviewedBy}
                    </p>
                  </div>
                )}
              </dl>
            </div>
          </div>
        </div>
      </AdminLayout>
    </>
  );
}

// ── Helper component ──────────────────────────────────────────────────

function DetailItem({
  label,
  value,
  isLink,
  href,
  mono,
}: {
  label: string;
  value: string | null | undefined;
  isLink?: boolean;
  href?: string;
  mono?: boolean;
}) {
  if (!value || value === "Not provided") {
    return (
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
          {label}
        </p>
        <p className="text-sm text-[var(--muted)] font-body italic">
          Not provided
        </p>
      </div>
    );
  }

  if (isLink && href) {
    return (
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
          {label}
        </p>
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--primary)] hover:underline font-body truncate block"
        >
          {value} ↗
        </a>
      </div>
    );
  }

  if (isLink) {
    return (
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
          {label}
        </p>
        <a
          href={value}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-[var(--primary)] hover:underline font-body truncate block"
        >
          {value} ↗
        </a>
      </div>
    );
  }

  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--muted)] font-body">
        {label}
      </p>
      <p
        className={`text-sm text-[var(--text-secondary)] font-body ${
          mono ? "font-mono text-xs" : ""
        }`}
      >
        {value}
      </p>
    </div>
  );
}
