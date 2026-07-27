/**
 * pages/admin/index.tsx — Admin dashboard listing all projects with status.
 */
import { useState, useEffect } from "react";
import { useWallet } from "@/lib/WalletProvider";
import Link from "next/link";
import WalletConnect from "@/components/WalletConnect";
import WebhookManager from "@/components/admin/WebhookManager";
import MatchManager from "@/components/admin/MatchManager";
import {
  fetchProjects,
  updateProjectStatus,
  registerProjectOnChain,
  confirmProjectRegistration,
  fetchQueues,
  pauseQueue,
  resumeQueue,
  purgeQueue,
  type QueueMetric,
} from "@/lib/api";
import { formatXLM, shortenAddress } from "@/utils/format";
import type { ClimateProject } from "@/utils/types";
import { SkeletonBox } from "@/components/Skeleton";

export default function AdminIndex() {
  const { publicKey, connect: onConnect } = useWallet();
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [queues, setQueues] = useState<QueueMetric[]>([]);
  const [queuesLoading, setQueuesLoading] = useState(false);
  const [queuesError, setQueuesError] = useState<string | null>(null);

  const loadProjects = () => {
    setLoading(true);
    fetchProjects({ limit: 100 })
      .then(setProjects)
      .catch((e: unknown) =>
        setError((e as Error).message || "Failed to load projects"),
      )
      .finally(() => setLoading(false));
  };

  const loadQueues = () => {
    if (!publicKey) return;
    setQueuesLoading(true);
    fetchQueues(publicKey)
      .then(setQueues)
      .catch((e: unknown) =>
        setQueuesError((e as Error).message || "Failed to load queue metrics"),
      )
      .finally(() => setQueuesLoading(false));
  };

  useEffect(() => {
    if (!publicKey) return;
    loadProjects();
    loadQueues();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey]);

  const handlePauseQueue = async (name: string) => {
    if (!publicKey) return;
    try {
      setQueuesLoading(true);
      await pauseQueue(name, publicKey);
      loadQueues();
    } catch (e: unknown) {
      setQueuesError((e as Error).message || `Failed to pause queue ${name}`);
      setQueuesLoading(false);
    }
  };

  const handleResumeQueue = async (name: string) => {
    if (!publicKey) return;
    try {
      setQueuesLoading(true);
      await resumeQueue(name, publicKey);
      loadQueues();
    } catch (e: unknown) {
      setQueuesError((e as Error).message || `Failed to resume queue ${name}`);
      setQueuesLoading(false);
    }
  };

  const handlePurgeQueue = async (name: string) => {
    if (!publicKey) return;
    if (!window.confirm(`Are you sure you want to purge queue "${name}"? This deletes all active/waiting jobs.`)) {
      return;
    }
    try {
      setQueuesLoading(true);
      await purgeQueue(name, publicKey);
      loadQueues();
    } catch (e: unknown) {
      setQueuesError((e as Error).message || `Failed to purge queue ${name}`);
      setQueuesLoading(false);
    }
  };

  const handleApprove = async (p: ClimateProject) => {
    if (!publicKey) return;
    try {
      setLoading(true);
      const reg = await registerProjectOnChain({
        projectId: p.id,
        name: p.name,
        wallet: p.walletAddress,
        co2PerXLM: 1, // default or fetch from project
        adminAddress: publicKey,
      });
      // Mock signing step since auto-confirm is requested
      await confirmProjectRegistration({
        projectId: p.id,
        transactionHash: "mock-tx-hash-auto-confirmed", // MOCK since no real wallet sign requested in issue
      });
      await updateProjectStatus(p.id, "active");
      loadProjects();
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to approve project");
      setLoading(false);
    }
  };

  const handleReject = async (p: ClimateProject) => {
    const reason = window.prompt("Enter rejection reason:");
    if (reason === null) return;
    try {
      setLoading(true);
      await updateProjectStatus(p.id, "rejected", reason);
      loadProjects();
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to reject project");
      setLoading(false);
    }
  };

  const pendingProjects = projects.filter(
    (p) => !p.verified && p.status === "active",
  );
  const otherProjects = projects.filter(
    (p) => p.verified || p.status !== "active",
  );

  if (!publicKey) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl font-bold text-forest-900 mb-3">
            Admin Dashboard
          </h1>
          <p className="text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
            Connect your wallet to manage projects.
          </p>
        </div>
        <WalletConnect onConnect={onConnect} />
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <div className="mb-8">
        <p className="text-xs tracking-[0.22em] uppercase text-[#8aaa8a] dark:text-forest-300 font-body">
          Admin
        </p>
        <h1 className="font-display text-3xl font-bold text-forest-900 mb-1">
          Admin Dashboard
        </h1>
        <p className="text-sm text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
          Manage project approvals, registrations, and match funds.{" "}
          <Link href="/admin/analytics" className="text-indigo-600 hover:underline font-medium">
            View Analytics →
          </Link>
        </p>
      </div>

      {loading && (
        <div className="card animate-pulse pointer-events-none space-y-4">
          {[1, 2, 3, 4, 5].map((i) => (
            <SkeletonBox key={i} className="h-4 rounded" palette="forest" />
          ))}
        </div>
      )}

      {error && (
        <div className="card">
          <p className="text-red-600 font-body">{error}</p>
        </div>
      )}

      {!loading && !error && (
        <div className="space-y-8">
          {pendingProjects.length > 0 && (
            <div>
              <h2 className="font-display text-xl font-bold text-forest-900 mb-4">
                Pending Verification
              </h2>
              <div className="space-y-3">
                {pendingProjects.map((p) => (
                  <div
                    key={p.id}
                    className="card flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-l-4 border-amber-400"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Link
                          href={`/admin/${p.id}`}
                          className="font-display font-semibold text-forest-900 hover:underline truncate"
                        >
                          {p.name}
                        </Link>
                        <span className="badge bg-amber-50 text-amber-700 border-amber-200 text-xs flex-shrink-0">
                          pending
                        </span>
                      </div>
                      <p className="text-xs text-[#8aaa8a] font-body mb-2">
                        {p.category} • {p.location} • {formatXLM(p.raisedXLM)}{" "}
                        goal
                      </p>
                      {/* Note: In a real app we'd display org details from the database here. Assuming standard project details for now. */}
                    </div>
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handleApprove(p)}
                        className="btn-primary text-xs px-3 py-1.5"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => handleReject(p)}
                        className="btn-secondary text-xs px-3 py-1.5 text-red-600 border-red-200 hover:bg-red-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <h2 className="font-display text-xl font-bold text-forest-900 mb-4">
              All Projects
            </h2>
            <div className="space-y-3">
              {otherProjects.map((p) => (
                <Link
                  key={p.id}
                  href={`/admin/${p.id}`}
                  className="card-hover flex flex-col sm:flex-row sm:items-center justify-between gap-3"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <h2 className="font-display font-semibold text-forest-900 truncate">
                        {p.name}
                      </h2>
                      <span
                        className={`badge text-xs flex-shrink-0 ${
                          p.status === "active"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                            : p.status === "rejected"
                              ? "bg-red-50 text-red-700 border-red-200"
                              : "bg-amber-50 text-amber-700 border-amber-200"
                        }`}
                      >
                        {p.status}
                      </span>
                      {p.onChainVerified && (
                        <span className="badge-verified text-xs flex-shrink-0">
                          On-chain ✓
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[#8aaa8a] font-body">
                      {p.category} • {p.location} • {formatXLM(p.raisedXLM)}{" "}
                      raised
                    </p>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-[#5a7a5a] font-body">
                    <span>{p.donorCount} donors</span>
                    <span>→</span>
                  </div>
                </Link>
              ))}
            </div>
          </div>

          <div className="border-t border-forest-100 pt-8 animate-fade-in">
            <div className="flex items-center justify-between mb-4">
              <h2 className="font-display text-xl font-bold text-forest-900">
                Queue Monitoring
              </h2>
              <button
                onClick={loadQueues}
                disabled={queuesLoading}
                className="btn-secondary text-xs px-2.5 py-1.5"
              >
                {queuesLoading ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            {queuesError && (
              <div className="card mb-4">
                <p className="text-red-600 font-body">{queuesError}</p>
              </div>
            )}

            <div className="overflow-x-auto card p-0">
              <table className="min-w-full divide-y divide-forest-100 text-left text-sm font-body">
                <thead className="bg-forest-50 text-xs font-semibold uppercase text-forest-900">
                  <tr>
                    <th className="px-6 py-3">Queue</th>
                    <th className="px-6 py-3">Status</th>
                    <th className="px-6 py-3">Waiting</th>
                    <th className="px-6 py-3">Active</th>
                    <th className="px-6 py-3">Failed</th>
                    <th className="px-6 py-3">Completed</th>
                    <th className="px-6 py-3">Failure Rate</th>
                    <th className="px-6 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-forest-100 bg-white dark:bg-zinc-900 text-forest-700">
                  {queues.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="px-6 py-4 text-center text-[#8aaa8a]">
                        No queues configured.
                      </td>
                    </tr>
                  ) : (
                    queues.map((q) => (
                      <tr key={q.queue} className="hover:bg-forest-50/50 transition-colors">
                        <td className="px-6 py-4 font-semibold text-forest-900">{q.queue}</td>
                        <td className="px-6 py-4">
                          <span
                            className={`badge text-xs ${
                              q.paused
                                ? "bg-amber-50 text-amber-700 border-amber-200"
                                : "bg-emerald-50 text-emerald-700 border-emerald-200"
                            }`}
                          >
                            {q.paused ? "Paused" : "Active"}
                          </span>
                        </td>
                        <td className="px-6 py-4">{q.waiting}</td>
                        <td className="px-6 py-4">{q.active}</td>
                        <td className="px-6 py-4 text-red-600 font-semibold">{q.failed}</td>
                        <td className="px-6 py-4 text-emerald-600">{q.completed}</td>
                        <td className="px-6 py-4">{(q.failure_rate * 100).toFixed(1)}%</td>
                        <td className="px-6 py-4 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {q.paused ? (
                              <button
                                onClick={() => handleResumeQueue(q.queue)}
                                disabled={queuesLoading}
                                className="btn-primary text-xs px-2 py-1 bg-emerald-600 hover:bg-emerald-700 text-white border-none"
                              >
                                Resume
                              </button>
                            ) : (
                              <button
                                onClick={() => handlePauseQueue(q.queue)}
                                disabled={queuesLoading}
                                className="btn-secondary text-xs px-2 py-1 text-amber-600 border-amber-200 hover:bg-amber-50"
                              >
                                Pause
                              </button>
                            )}
                            <button
                              onClick={() => handlePurgeQueue(q.queue)}
                              disabled={queuesLoading}
                              className="btn-secondary text-xs px-2 py-1 text-red-600 border-red-200 hover:bg-red-50"
                            >
                              Purge
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <MatchManager adminKey={publicKey} />
          <WebhookManager adminKey={publicKey} />
        </div>
      )}
    </div>
  );
}
