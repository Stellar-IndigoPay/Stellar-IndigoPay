/**
 * pages/admin/co2-flags.tsx — CO₂ Verification Flags Dashboard
 *
 * Lists projects whose self-reported CO₂ offset rate was flagged (>10×
 * the category benchmark) or marked for review (3–10×) by the backend's
 * automated verifier, and lets an admin resolve each flag by accepting
 * ("Approve rate") or rejecting ("Reject rate") the claimed figure.
 *
 * API endpoints (admin-only, Bearer JWT):
 *   - GET   /api/v1/admin/co2/flags?status=&page=&limit=
 *   - PATCH /api/v1/admin/co2/flags/:projectId/resolve
 */
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import AdminLayout from "@/components/admin/AdminLayout";
import { adminFetch, isAdminAuthenticated } from "@/lib/adminAuth";

const PAGE_SIZE = 20;

interface FlaggedProject {
  id: string;
  name: string;
  category: string;
  location: string;
  walletAddress: string;
  verified: boolean;
  co2VerificationStatus: string;
  co2VerificationNotes: string | null;
  co2OffsetKg: number;
  updatedAt: string | null;
}

const STATUS_TABS: Array<{ key: string; label: string }> = [
  { key: "", label: "Needs Attention" },
  { key: "flagged", label: "Flagged" },
  { key: "review", label: "Review" },
  { key: "verified", label: "Verified" },
  { key: "rejected", label: "Rejected" },
];

const STATUS_BADGES: Record<string, string> = {
  flagged:
    "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border-red-200 dark:border-red-800/30",
  review:
    "bg-amber-50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-300 border-amber-200 dark:border-amber-800/30",
  verified:
    "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800/30",
  rejected:
    "bg-slate-100 dark:bg-slate-800/40 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700/40",
  pending:
    "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-300 border-blue-200 dark:border-blue-800/30",
};

export default function AdminCO2FlagsPage() {
  const router = useRouter();
  const [projects, setProjects] = useState<FlaggedProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  useEffect(() => {
    if (!isAdminAuthenticated()) {
      router.replace("/admin/login");
    }
  }, [router]);

  const fetchFlags = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      query.set("limit", String(PAGE_SIZE));
      query.set("page", String(page));
      if (statusFilter) query.set("status", statusFilter);

      const res = await adminFetch(
        `/api/v1/admin/co2/flags?${query.toString()}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error || body?.message || `Request failed (${res.status})`,
        );
      }
      const body = await res.json();
      const items = body.data || [];
      setProjects(items);
      setHasMore(items.length >= PAGE_SIZE);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load CO₂ flags";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter]);

  useEffect(() => {
    fetchFlags();
  }, [fetchFlags]);

  const handleResolve = async (
    projectId: string,
    resolution: "verified" | "rejected",
  ) => {
    const label =
      resolution === "verified"
        ? "accept this project's claimed CO₂ rate"
        : "reject this project's claimed CO₂ rate";
    const notes = window.prompt(
      `You are about to ${label}. Optional resolution note:`,
      "",
    );
    if (notes === null) return; // Cancelled

    setActionLoading(projectId);
    setError(null);
    try {
      const res = await adminFetch(
        `/api/v1/admin/co2/flags/${projectId}/resolve`,
        {
          method: "PATCH",
          body: JSON.stringify({
            resolution,
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error || body?.message || "Failed to resolve flag",
        );
      }
      await fetchFlags();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to resolve flag";
      setError(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const handleStatusFilter = (key: string) => {
    setStatusFilter(key);
    setPage(1);
  };

  return (
    <>
      <Head>
        <title>CO₂ Flags — Admin — Stellar-IndigoPay</title>
      </Head>
      <AdminLayout>
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs tracking-[0.22em] uppercase text-[var(--muted)] font-body mb-1">
            Admin
          </p>
          <h1 className="font-display text-3xl font-bold text-[var(--text)]">
            CO₂ Verification Flags
          </h1>
          <p className="text-sm text-[var(--text-secondary)] font-body mt-1">
            Projects whose claimed CO₂ offset rate falls outside industry
            benchmarks and needs an admin decision
          </p>
        </div>

        {/* Error banner */}
        {error && (
          <div className="flex items-start gap-2.5 p-3 rounded-xl bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30 mb-6">
            <span className="text-red-500 text-sm mt-0.5">⚠️</span>
            <p className="text-sm text-red-700 dark:text-red-300 font-body flex-1">
              {error}
            </p>
            <button
              onClick={() => {
                setError(null);
                fetchFlags();
              }}
              className="text-xs font-semibold text-red-700 dark:text-red-300 hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Status filter tabs */}
        <div className="flex flex-wrap items-center gap-2 mb-6">
          {STATUS_TABS.map((tab) => {
            const isActive = statusFilter === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => handleStatusFilter(tab.key)}
                className={`px-4 py-2 rounded-xl text-sm font-semibold transition-all duration-150 font-body ${
                  isActive
                    ? "bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white shadow-md"
                    : "bg-white dark:bg-[#14142D] text-[var(--text-secondary)] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] hover:border-[rgba(99,102,241,0.25)] dark:hover:border-[rgba(129,140,248,0.30)]"
                }`}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Table */}
        <div className="overflow-x-auto rounded-2xl border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D]">
          <table className="min-w-full text-sm font-body">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-wider text-[var(--muted)] border-b border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)]">
                <th className="px-4 py-3 font-semibold">Project</th>
                <th className="px-4 py-3 font-semibold">Category</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Reason</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-10 text-center text-[var(--muted)]"
                  >
                    Loading CO₂ flags…
                  </td>
                </tr>
              ) : projects.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-4 py-10 text-center text-[var(--muted)]"
                  >
                    🎉 No projects need attention
                  </td>
                </tr>
              ) : (
                projects.map((p) => (
                  <tr
                    key={p.id}
                    className="border-b last:border-b-0 border-[rgba(99,102,241,0.06)] dark:border-[rgba(129,140,248,0.08)]"
                  >
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[var(--text)]">
                        {p.name}
                      </p>
                      <p className="text-xs text-[var(--muted)] font-mono">
                        {p.walletAddress.slice(0, 6)}…
                        {p.walletAddress.slice(-6)}
                      </p>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)]">
                      {p.category}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold border ${
                          STATUS_BADGES[p.co2VerificationStatus] ||
                          STATUS_BADGES.pending
                        }`}
                      >
                        {p.co2VerificationStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[var(--text-secondary)] max-w-md">
                      {p.co2VerificationNotes || "—"}
                    </td>
                    <td className="px-4 py-3 text-right whitespace-nowrap">
                      {["flagged", "review"].includes(
                        p.co2VerificationStatus,
                      ) && (
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => handleResolve(p.id, "verified")}
                            disabled={actionLoading === p.id}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40 transition-all"
                          >
                            Approve rate
                          </button>
                          <button
                            onClick={() => handleResolve(p.id, "rejected")}
                            disabled={actionLoading === p.id}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-red-600 hover:bg-red-700 text-white disabled:opacity-40 transition-all"
                          >
                            Reject rate
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {(page > 1 || hasMore) && (
          <div className="flex items-center justify-between mt-6">
            <p className="text-sm text-[var(--text-secondary)] font-body">
              Page {page}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1 || loading}
                className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] disabled:opacity-40 transition-all font-body"
              >
                ← Previous
              </button>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasMore || loading}
                className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] disabled:opacity-40 transition-all font-body"
              >
                Next →
              </button>
            </div>
          </div>
        )}
      </AdminLayout>
    </>
  );
}
