import Head from "next/head";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import AdminLayout from "@/components/admin/AdminLayout";
import WalletConnect from "@/components/WalletConnect";
import StatCard from "@/components/admin/StatCard";
import QuickActionButton from "@/components/admin/QuickActionButton";
import StatusDot from "@/components/admin/StatusDot";
import { SkeletonBox } from "@/components/Skeleton";
import {
  fetchQueues,
  fetchIndexerStatus,
  fetchVerificationRequests,
  type VerificationRequestResponse,
} from "@/lib/api";
import { formatDate, CATEGORY_ICONS } from "@/utils/format";
import { STATUS_COLORS, STATUS_LABELS, type VerificationStatus } from "@/components/admin/VerificationTable";

interface AdminIndexProps {
  publicKey: string | null;
  onConnect: (pk: string) => void;
}

function VerificationRow({ verification }: { verification: VerificationRequestResponse }) {
  const status = verification.status as VerificationStatus;
  const icon = CATEGORY_ICONS[verification.projectCategory] || "🌿";
  return (
    <div
      className="card flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] bg-white dark:bg-[#14142D] hover:border-[rgba(99,102,241,0.20)] dark:hover:border-[rgba(129,140,248,0.22)] transition-all duration-200"
      data-testid={`verification-row-${verification.id}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2.5 mb-1.5 flex-wrap">
          <span className="text-sm font-bold text-[var(--text)] font-body">
            {verification.organizationName}
          </span>
          <span
            className={`inline-flex text-[10px] font-bold px-2 py-0.5 rounded-full border uppercase tracking-wider ${
              STATUS_COLORS[status] || STATUS_COLORS.pending
            }`}
          >
            {STATUS_LABELS[status] || status}
          </span>
        </div>
        <p className="text-sm font-medium text-[var(--text-secondary)] font-body">
          {icon} {verification.projectName}
        </p>
        <p className="text-xs text-[var(--muted)] font-body mt-1">
          {verification.projectCategory} • {verification.projectLocation} • Submitted{" "}
          {verification.submittedAt ? formatDate(verification.submittedAt) : "—"}
        </p>
      </div>
      <div>
        <Link
          href={`/admin/verification/${verification.id}`}
          className="inline-flex items-center justify-center px-4 py-2 rounded-xl text-xs font-semibold bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white hover:opacity-90 transition-all shadow-md shadow-indigo-500/10 hover:shadow-indigo-500/20"
        >
          Review
        </Link>
      </div>
    </div>
  );
}

export default function AdminIndex({ publicKey, onConnect }: AdminIndexProps) {
  const {
    data: queues,
    isLoading: queuesLoading,
    error: queuesError,
    refetch: refetchQueues,
  } = useQuery({
    queryKey: ["admin", "queues"],
    queryFn: () => fetchQueues(publicKey || ""),
    refetchInterval: 30_000,
    enabled: !!publicKey,
  });

  const {
    data: indexerStatus,
    isLoading: indexerLoading,
    error: indexerError,
    refetch: refetchIndexer,
  } = useQuery({
    queryKey: ["admin", "indexer"],
    queryFn: () => fetchIndexerStatus(publicKey || ""),
    refetchInterval: 30_000,
    enabled: !!publicKey,
  });

  const {
    data: pendingVerifications,
    isLoading: pendingLoading,
    error: pendingError,
    refetch: refetchPending,
  } = useQuery({
    queryKey: ["verifications", "pending"],
    queryFn: () => fetchVerificationRequests({ status: "pending", limit: 5 }),
    refetchInterval: 60_000,
    enabled: !!publicKey,
  });

  if (!publicKey) {
    return (
      <AdminLayout>
        <Head>
          <title>Admin Dashboard — Stellar-IndigoPay</title>
        </Head>
        <div className="max-w-xl mx-auto px-4 sm:px-6 py-16 text-center animate-fade-in">
          <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          </div>
          <h1 className="font-display text-3xl font-bold text-[var(--text)] mb-3">
            Admin Dashboard
          </h1>
          <p className="text-sm text-[var(--text-secondary)] font-body mb-8 max-w-sm mx-auto">
            Connect your administrator Stellar wallet to verify queue metrics, check background indexer health, and manage verifications.
          </p>
          <div className="card p-6 border border-[rgba(99,102,241,0.08)] bg-white dark:bg-[#14142D] shadow-sm max-w-sm mx-auto">
            <WalletConnect onConnect={onConnect} />
          </div>
        </div>
      </AdminLayout>
    );
  }

  // Derived queue values
  const totalActive = queues?.reduce((acc, q) => acc + q.active, 0) ?? 0;
  const totalWaiting = queues?.reduce((acc, q) => acc + q.waiting, 0) ?? 0;
  const totalFailed = queues?.reduce((acc, q) => acc + q.failed, 0) ?? 0;
  const totalCompleted = queues?.reduce((acc, q) => acc + q.completed, 0) ?? 0;

  return (
    <AdminLayout>
      <Head>
        <title>Admin Dashboard — Stellar-IndigoPay</title>
      </Head>

      <div className="mb-8">
        <p className="text-xs tracking-[0.22em] uppercase text-[var(--muted)] font-body mb-1">
          System Overview
        </p>
        <h1 className="font-display text-3xl font-bold text-[var(--text)] leading-tight">
          Admin Dashboard
        </h1>
        <p className="text-sm text-[var(--text-secondary)] font-body mt-1">
          Monitor real-time system health, worker queues, and manage organization registrations.
        </p>
      </div>

      {/* Queue Health */}
      <section className="mb-10" aria-labelledby="queue-health-title">
        <div className="flex items-center justify-between mb-4">
          <h2 id="queue-health-title" className="font-display text-lg font-bold text-[var(--text)]">
            Queue Health
          </h2>
          {queuesError && (
            <button
              onClick={() => refetchQueues()}
              className="text-xs font-semibold text-rose-600 hover:underline flex items-center gap-1"
            >
              ⚠️ Retry Load
            </button>
          )}
        </div>

        {queuesError && (
          <div className="flex items-center justify-between p-4 mb-4 text-sm text-rose-700 bg-rose-50/50 border border-rose-200 rounded-2xl dark:bg-rose-950/20 dark:text-rose-400 dark:border-rose-900/30">
            <span className="font-body">Failed to load queue metrics: {(queuesError as Error).message || "Unknown error"}</span>
            <button onClick={() => refetchQueues()} className="font-semibold underline hover:no-underline">Retry</button>
          </div>
        )}

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard title="Active Jobs" value={totalActive} color="blue" loading={queuesLoading} />
          <StatCard title="Waiting Jobs" value={totalWaiting} color="amber" loading={queuesLoading} />
          <StatCard title="Failed Jobs" value={totalFailed} color="red" loading={queuesLoading} />
          <StatCard title="Completed (24h)" value={totalCompleted} color="green" loading={queuesLoading} />
        </div>
      </section>

      {/* Indexer Status */}
      <section className="mb-10" aria-labelledby="indexer-status-title">
        <div className="flex items-center justify-between mb-4">
          <h2 id="indexer-status-title" className="font-display text-lg font-bold text-[var(--text)]">
            Indexer Status
          </h2>
          {indexerError && (
            <button
              onClick={() => refetchIndexer()}
              className="text-xs font-semibold text-rose-600 hover:underline flex items-center gap-1"
            >
              ⚠️ Retry Load
            </button>
          )}
        </div>

        {indexerError && (
          <div className="flex items-center justify-between p-4 mb-4 text-sm text-rose-700 bg-rose-50/50 border border-rose-200 rounded-2xl dark:bg-rose-950/20 dark:text-rose-400 dark:border-rose-900/30">
            <span className="font-body">Failed to load indexer status: {(indexerError as Error).message || "Unknown error"}</span>
            <button onClick={() => refetchIndexer()} className="font-semibold underline hover:no-underline">Retry</button>
          </div>
        )}

        {indexerLoading ? (
          <div className="card p-4 flex items-center gap-4 border border-[rgba(99,102,241,0.08)] bg-white dark:bg-[#14142D] animate-pulse">
            <SkeletonBox className="w-3.5 h-3.5 rounded-full" palette="indigo" />
            <SkeletonBox className="h-4 w-40 rounded" palette="indigo" />
          </div>
        ) : (
          <div className="card p-5 flex items-center justify-between border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] bg-white dark:bg-[#14142D] shadow-sm">
            <div className="flex items-center gap-3.5">
              <StatusDot status={indexerStatus?.active ? "green" : "red"} />
              <div>
                <p className="text-sm font-semibold text-[var(--text)] font-body">
                  Stellar Horizon Stream
                </p>
                <p className="text-xs text-[var(--text-secondary)] font-body mt-0.5">
                  Status: {indexerStatus?.active ? "Connected & Listening" : "Disconnected"}
                </p>
              </div>
            </div>
            <div className="text-right">
              <span className="text-sm font-semibold text-[var(--text)] font-body">
                Lag: {indexerStatus?.lagLedgers ?? "—"} ledgers
              </span>
              <p className="text-[10px] text-[var(--muted)] font-body uppercase tracking-wider mt-0.5">
                Behind Chain Tip
              </p>
            </div>
          </div>
        )}
      </section>

      {/* Pending Verifications */}
      <section className="mb-10" aria-labelledby="pending-verifications-title">
        <div className="flex items-center justify-between mb-4">
          <h2 id="pending-verifications-title" className="font-display text-lg font-bold text-[var(--text)]">
            Pending Verifications
          </h2>
          <div className="flex items-center gap-2">
            {pendingError && (
              <button
                onClick={() => refetchPending()}
                className="text-xs font-semibold text-rose-600 hover:underline flex items-center gap-1"
              >
                ⚠️ Retry Load
              </button>
            )}
            <Link
              href="/admin/verification"
              className="text-xs font-semibold text-[var(--primary)] hover:underline"
            >
              View Full Queue →
            </Link>
          </div>
        </div>

        {pendingError && (
          <div className="flex items-center justify-between p-4 mb-4 text-sm text-rose-700 bg-rose-50/50 border border-rose-200 rounded-2xl dark:bg-rose-950/20 dark:text-rose-400 dark:border-rose-900/30">
            <span className="font-body">Failed to load verification requests: {(pendingError as Error).message || "Unknown error"}</span>
            <button onClick={() => refetchPending()} className="font-semibold underline hover:no-underline">Retry</button>
          </div>
        )}

        <div className="space-y-3">
          {pendingLoading ? (
            [1, 2, 3].map((i) => (
              <div key={i} className="card p-4 border border-[rgba(99,102,241,0.08)] bg-white dark:bg-[#14142D] animate-pulse space-y-2" data-testid="verification-skeleton">
                <SkeletonBox className="h-4 w-1/3 rounded" palette="indigo" />
                <SkeletonBox className="h-3 w-1/2 rounded" palette="indigo" />
                <SkeletonBox className="h-3 w-1/4 rounded" palette="indigo" />
              </div>
            ))
          ) : !pendingVerifications || pendingVerifications.length === 0 ? (
            <div className="card text-center py-10 border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] bg-white dark:bg-[#14142D] shadow-sm">
              <span className="text-4xl block mb-2">🌿</span>
              <p className="text-sm font-semibold text-[var(--text)] font-body">
                No Pending Verifications
              </p>
              <p className="text-xs text-[var(--muted)] font-body mt-1">
                Organizations are all caught up!
              </p>
            </div>
          ) : (
            pendingVerifications.map((v) => (
              <VerificationRow key={v.id} verification={v} />
            ))
          )}
        </div>
      </section>

      {/* Quick Actions */}
      <section aria-labelledby="quick-actions-title">
        <h2 id="quick-actions-title" className="font-display text-lg font-bold text-[var(--text)] mb-4">
          Quick Actions
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          <QuickActionButton href="/admin/verification" label="Review Verifications" />
          <QuickActionButton href="/admin/queues" label="View Queues" />
          <QuickActionButton href="/admin/co2-flags" label="CO₂ Flags" />
          <QuickActionButton href="/admin/analytics" label="Analytics" />
          <QuickActionButton href="/admin/webhooks" label="Webhook DLQ" />
          <QuickActionButton href="/admin/audit" label="Audit Log" />
        </div>
      </section>
    </AdminLayout>
  );
}
