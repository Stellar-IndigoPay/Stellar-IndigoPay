/**
 * pages/admin/audit.tsx — Admin Audit Log Viewer
 *
 * Displays the admin audit log with filtering, pagination, and CSV export.
 *
 * API endpoints:
 *   - GET /api/admin/audit-log?filters (admin JWT required)
 *   - GET /api/admin/audit-log/export/csv?filters (admin JWT required)
 *   - GET /api/admin/audit-log/stats (admin JWT required)
 */
import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import AdminLayout from "@/components/admin/AdminLayout";
import AuditLogTable, {
  type AuditLogEntry,
  type AuditLogFilters,
  DEFAULT_FILTERS,
} from "@/components/admin/AuditLogTable";
import { isAdminAuthenticated, adminFetch } from "@/lib/adminAuth";

const PAGE_SIZE = 50;

export default function AdminAuditPage() {
  const router = useRouter();
  const [logs, setLogs] = useState<AuditLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<AuditLogFilters>(DEFAULT_FILTERS);
  const [exporting, setExporting] = useState(false);
  const [distinctActions, setDistinctActions] = useState<string[]>([]);

  // Check auth
  useEffect(() => {
    if (!isAdminAuthenticated()) {
      router.replace("/admin/login");
    }
  }, [router]);

  // Fetch audit log entries
  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));

      if (filters.actor) params.set("actor", filters.actor);
      if (filters.action) params.set("action", filters.action);
      if (filters.targetType) params.set("targetType", filters.targetType);
      if (filters.targetId) params.set("targetId", filters.targetId);
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) params.set("dateTo", filters.dateTo);
      if (filters.search) params.set("search", filters.search);

      const res = await adminFetch(
        `/api/v1/admin/audit-log?${params.toString()}`,
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body?.error || body?.message || `Request failed (${res.status})`,
        );
      }

      const body = await res.json();
      setLogs(body.data || []);
      setTotal(body.total || 0);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to load audit log";
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [page, filters]);

  // Fetch distinct actions from stats endpoint
  const fetchDistinctActions = useCallback(async () => {
    try {
      const res = await adminFetch("/api/v1/admin/audit-log/stats");
      if (res.ok) {
        const body = await res.json();
        const topActions: Array<{ action: string }> = body.data?.topActions || [];
        setDistinctActions(topActions.map((a) => a.action));
      }
    } catch {
      // Best-effort — the action dropdown will just be empty
    }
  }, []);

  // Initial data load — fetch logs on filter/page change
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Fetch distinct actions only once on mount (stats don't change per filter)
  useEffect(() => {
    fetchDistinctActions();
  }, [fetchDistinctActions]);

  // Debounced filter changes reset page to 1
  const handleFilterChange = useCallback(
    (newFilters: AuditLogFilters) => {
      setFilters(newFilters);
      setPage(1);
    },
    [],
  );

  // CSV export
  const handleExport = useCallback(async () => {
    setExporting(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filters.actor) params.set("actor", filters.actor);
      if (filters.action) params.set("action", filters.action);
      if (filters.targetType) params.set("targetType", filters.targetType);
      if (filters.targetId) params.set("targetId", filters.targetId);
      if (filters.dateFrom) params.set("dateFrom", filters.dateFrom);
      if (filters.dateTo) params.set("dateTo", filters.dateTo);
      if (filters.search) params.set("search", filters.search);

      const res = await adminFetch(
        `/api/v1/admin/audit-log/export/csv?${params.toString()}`,
      );

      if (!res.ok) {
        if (res.status === 429) {
          const body = await res.json().catch(() => ({}));
          throw new Error(
            body?.error ||
              `Export rate limited. Retry after ${body?.retryAfter || 300} seconds.`,
          );
        }
        throw new Error(`Export failed (${res.status})`);
      }

      // Trigger CSV download from the response
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-log-export-${Date.now()}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to export audit log";
      setError(msg);
    } finally {
      setExporting(false);
    }
  }, [filters]);

  return (
    <>
      <Head>
        <title>Audit Log — Admin — Stellar-IndigoPay</title>
      </Head>
      <AdminLayout>
        {/* Header */}
        <div className="mb-8">
          <p className="text-xs tracking-[0.22em] uppercase text-[var(--muted)] font-body mb-1">
            Admin
          </p>
          <h1 className="font-display text-3xl font-bold text-[var(--text)]">
            Audit Log
          </h1>
          <p className="text-sm text-[var(--text-secondary)] font-body mt-1">
            Track and review all admin actions for security and compliance
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
                fetchLogs();
              }}
              className="text-xs font-semibold text-red-700 dark:text-red-300 hover:underline shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {/* Audit log table with filters */}
        <AuditLogTable
          logs={logs}
          total={total}
          page={page}
          pageSize={PAGE_SIZE}
          loading={loading}
          filters={filters}
          onFilterChange={handleFilterChange}
          onPageChange={setPage}
          onExport={handleExport}
          exporting={exporting}
          distinctActions={distinctActions}
        />
      </AdminLayout>
    </>
  );
}
