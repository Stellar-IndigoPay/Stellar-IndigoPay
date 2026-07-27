/**
 * pages/admin/verification.tsx — Verification Request Queue Dashboard
 *
 * Displays all submitted verification requests in a filterable,
 * sortable, paginated table with status metrics. Admins can filter by
 * status, start reviews, and navigate to the detail view.
 *
 * API endpoints (admin-only, Bearer JWT):
 *   - GET /api/v1/verification-requests?status=&page=&limit=
 *   - PATCH /api/v1/verification-requests/:id/status
 */
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import AdminLayout from "@/components/admin/AdminLayout";
import VerificationTable from "@/components/admin/VerificationTable";
import VerificationFilters from "@/components/admin/VerificationFilters";
import {
  adminFetch,
  ensureAdminSession,
} from "@/lib/adminAuth";
import type { VerificationRequestResponse } from "@/lib/api";

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [10, 25, 50];

interface QueueMetrics {
  totalPending: number;
  totalInReview: number;
  oldestPendingDays: number | null;
  approvedThisMonth: number;
}

function computeMetrics(requests: VerificationRequestResponse[]): QueueMetrics {
  const now = new Date();

  const pending = requests.filter((r) => r.status === "pending");
  const inReview = requests.filter((r) => r.status === "in_review");
  const approvedThisMonth = requests.filter((r) => {
    if (r.status !== "approved" || !r.reviewedAt) return false;
    const reviewed = new Date(r.reviewedAt);
    return (
      reviewed.getMonth() === now.getMonth() &&
      reviewed.getFullYear() === now.getFullYear()
    );
  });

  // Oldest pending (in days)
  const pendingDates = pending
    .map((r) => (r.submittedAt ? new Date(r.submittedAt).getTime() : null))
    .filter((d): d is number => d !== null)
    .sort((a, b) => a - b); // oldest first

  const oldestPendingDays =
    pendingDates.length > 0
      ? Math.max(
          0,
          Math.floor((now.getTime() - pendingDates[0]) / (1000 * 60 * 60 * 24)),
        )
      : null;

  return {
    totalPending: pending.length,
    totalInReview: inReview.length,
    oldestPendingDays,
    approvedThisMonth: approvedThisMonth.length,
  };
}

export default function AdminVerificationPage() {
  const router = useRouter();
  const [requests, setRequests] = useState<VerificationRequestResponse[]>([]);
  const [allRequests, setAllRequests] = useState<VerificationRequestResponse[]>(
    [],
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Check auth
  useEffect(() => {
    ensureAdminSession().then((ok) => {
      if (!ok) {
        router.replace("/admin/login");
      }
    });
  }, [router]);

  // Fetch all requests (with optional status filter)
  const fetchRequests = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams();
      query.set("limit", String(pageSize));
      query.set("page", String(page));
      if (statusFilter) query.set("status", statusFilter);

      const res = await adminFetch(
        `/api/v1/verification-requests?${query.toString()}`,
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error || body?.message || `Request failed (${res.status})`,
        );
      }
      const body = await res.json();
      const items = body.data || [];
      setRequests(items);
      setHasMore(items.length >= pageSize);
    } catch (err: unknown) {
      const msg =
        err instanceof Error
          ? err.message
          : "Failed to load verification requests";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, statusFilter]);

  // Fetch all (unpaginated) for metrics, or use a separate metrics endpoint
  const fetchMetrics = useCallback(async () => {
    try {
      const res = await adminFetch("/api/v1/verification-requests?limit=200");
      if (res.ok) {
        const body = await res.json();
        setAllRequests(body.data || []);
      }
    } catch {
      // Metrics are best-effort
    }
  }, []);

  useEffect(() => {
    fetchRequests();
    fetchMetrics();
  }, [fetchRequests, fetchMetrics]);

  // Handle starting a review (transition pending → in_review)
  const handleStartReview = async (id: string) => {
    setActionLoading(id);
    setError(null);
    try {
      const res = await adminFetch(
        `/api/v1/verification-requests/${id}/status`,
        {
          method: "PATCH",
          body: JSON.stringify({ status: "in_review" }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error || body?.message || "Failed to start review",
        );
      }
      // Refresh both views
      await fetchRequests();
      await fetchMetrics();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to start review";
      setError(msg);
    } finally {
      setActionLoading(null);
    }
  };

  const metrics = computeMetrics(allRequests);

  // Filter tab handler
  const handleStatusFilter = (key: string) => {
    setStatusFilter(key);
    setPage(1);
  };

  const handlePageSizeChange = (nextPageSize: number) => {
    setPageSize(nextPageSize);
    setPage(1);
  };

  // Count per status from the metrics fetch
  const statusCounts: Record<string, number> = {
    "": allRequests.length,
    pending: metrics.totalPending,
    in_review: metrics.totalInReview,
    approved: allRequests.filter((r) => r.status === "approved").length,
    rejected: allRequests.filter((r) => r.status === "rejected").length,
  };

  return (
    <>
      <Head>
        <title>Verification Queue — Admin — Stellar-IndigoPay</title>
      </Head>
      <AdminLayout>
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs tracking-[0.22em] uppercase text-[var(--muted)] font-body mb-1">
            Admin
          </p>
          <h1 className="font-display text-3xl font-bold text-[var(--text)]">
            Verification Queue
          </h1>
          <p className="text-sm text-[var(--text-secondary)] font-body mt-1">
            Review and manage project verification requests
          </p>
        </div>

        {/* Metrics banner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
          {[
            {
              icon: "⏳",
              label: "Pending",
              value: metrics.totalPending,
              color: "text-amber-600 dark:text-amber-400",
            },
            {
              icon: "🔍",
              label: "In Review",
              value: metrics.totalInReview,
              color: "text-blue-600 dark:text-blue-400",
            },
            {
              icon: "📅",
              label: "Oldest Pending",
              value:
                metrics.oldestPendingDays !== null
                  ? `${metrics.oldestPendingDays}d`
                  : "—",
              color: "text-[var(--text)]",
            },
            {
              icon: "✅",
              label: "Approved This Month",
              value: metrics.approvedThisMonth,
              color: "text-emerald-600 dark:text-emerald-400",
            },
          ].map((stat) => (
            <div
              key={stat.label}
              className="stat-card"
            >
              <p className="text-lg mb-1">{stat.icon}</p>
              <p
                className={`font-display font-bold text-2xl leading-tight ${stat.color}`}
              >
                {stat.value}
              </p>
              <p className="text-[10px] text-[var(--muted)] font-body uppercase tracking-wider font-semibold mt-0.5">
                {stat.label}
              </p>
            </div>
          ))}
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
                fetchRequests();
              }}
              className="text-xs font-semibold text-red-700 dark:text-red-300 hover:underline"
            >
              Retry
            </button>
          </div>
        )}

        {/* Status filter pills */}
        <div className="mb-6">
          <VerificationFilters
            value={statusFilter}
            onChange={handleStatusFilter}
          />
        </div>

        {/* Table */}
        <VerificationTable
          requests={requests}
          loading={loading}
          error={null}
          onStartReview={handleStartReview}
          page={page}
          pageSize={pageSize}
          totalCount={statusCounts[statusFilter] ?? requests.length}
          onPageChange={(nextPage) => setPage(nextPage)}
          onPageSizeChange={handlePageSizeChange}
        />
      </AdminLayout>
    </>
  );
}

export const getServerSideProps = async () => {
  return { props: {} };
};
