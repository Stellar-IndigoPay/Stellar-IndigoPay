/**
 * components/admin/WebhookManager.tsx — Webhook dead-letter queue admin UI
 *
 * Lets an admin see webhook deliveries that exhausted their 6-attempt retry
 * budget, replay a single one or all of them for a project, and review
 * recent delivery history with status badges.
 */
import { useEffect, useState, useCallback } from "react";
import {
  fetchDeadLetterWebhooks,
  replayWebhookDelivery,
  replayAllWebhookDeliveries,
  fetchWebhookDeliveries,
  type WebhookDelivery,
} from "@/lib/api";
import { formatDate } from "@/utils/format";

interface WebhookManagerProps {
  adminKey: string;
}

const STATUS_BADGES: Record<WebhookDelivery["status"], string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  delivered: "bg-emerald-50 text-emerald-700 border-emerald-200",
  failed: "bg-amber-50 text-amber-700 border-amber-200",
  dlq: "bg-red-50 text-red-700 border-red-200",
};

export default function WebhookManager({ adminKey }: WebhookManagerProps) {
  const [projectId, setProjectId] = useState("");
  const [deadLetters, setDeadLetters] = useState<WebhookDelivery[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replayingId, setReplayingId] = useState<string | null>(null);
  const [replayingAll, setReplayingAll] = useState(false);

  const [history, setHistory] = useState<WebhookDelivery[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const loadDeadLetters = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchDeadLetterWebhooks(adminKey, {
      projectId: projectId || undefined,
      limit: 20,
    })
      .then((res) => {
        setDeadLetters(res.data);
        setTotal(res.total);
      })
      .catch((e: unknown) =>
        setError((e as Error).message || "Failed to load dead-letter queue"),
      )
      .finally(() => setLoading(false));
  }, [adminKey, projectId]);

  useEffect(() => {
    loadDeadLetters();
  }, [loadDeadLetters]);

  const loadHistory = () => {
    setHistoryLoading(true);
    fetchWebhookDeliveries(adminKey, { projectId: projectId || undefined, limit: 50 })
      .then(setHistory)
      .catch((e: unknown) => setError((e as Error).message || "Failed to load delivery history"))
      .finally(() => setHistoryLoading(false));
  };

  const handleReplay = async (deliveryId: string) => {
    try {
      setReplayingId(deliveryId);
      await replayWebhookDelivery(deliveryId, adminKey);
      loadDeadLetters();
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to replay delivery");
    } finally {
      setReplayingId(null);
    }
  };

  const handleReplayAll = async () => {
    if (!projectId) {
      setError("Enter a project ID to replay all dead-lettered deliveries for it");
      return;
    }
    try {
      setReplayingAll(true);
      await replayAllWebhookDeliveries(projectId, adminKey);
      loadDeadLetters();
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to replay deliveries");
    } finally {
      setReplayingAll(false);
    }
  };

  return (
    <div className="border-t border-forest-100 pt-8 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <h2 className="font-display text-xl font-bold text-forest-900">
          Webhook Dead-Letter Queue
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            placeholder="Filter by project ID..."
            className="input-field text-xs py-1.5 px-2.5 w-56"
          />
          <button
            onClick={handleReplayAll}
            disabled={replayingAll}
            className="btn-secondary text-xs px-2.5 py-1.5"
          >
            {replayingAll ? "Replaying..." : "Replay all for project"}
          </button>
          <button
            onClick={loadDeadLetters}
            disabled={loading}
            className="btn-secondary text-xs px-2.5 py-1.5"
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {error && (
        <div className="card mb-4">
          <p className="text-red-600 font-body">{error}</p>
        </div>
      )}

      <div className="overflow-x-auto card p-0">
        <table className="min-w-full divide-y divide-forest-100 text-left text-sm font-body">
          <thead className="bg-forest-50 text-xs font-semibold uppercase text-forest-900">
            <tr>
              <th className="px-6 py-3">Project</th>
              <th className="px-6 py-3">Event Type</th>
              <th className="px-6 py-3">Failed At</th>
              <th className="px-6 py-3">Attempts</th>
              <th className="px-6 py-3">Last Error</th>
              <th className="px-6 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-forest-100 bg-white dark:bg-zinc-900 text-forest-700">
            {deadLetters.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-6 py-4 text-center text-[#8aaa8a]">
                  {loading ? "Loading..." : "No dead-lettered webhook deliveries."}
                </td>
              </tr>
            ) : (
              deadLetters.map((d) => (
                <tr key={d.id} className="hover:bg-forest-50/50 transition-colors">
                  <td className="px-6 py-4 font-semibold text-forest-900">
                    {d.projectName || d.projectId}
                  </td>
                  <td className="px-6 py-4">{d.eventType}</td>
                  <td className="px-6 py-4">
                    {d.lastAttemptAt ? formatDate(d.lastAttemptAt) : "—"}
                  </td>
                  <td className="px-6 py-4">{d.attempts}</td>
                  <td className="px-6 py-4 max-w-xs truncate text-red-600" title={d.lastError || ""}>
                    {d.lastError || "—"}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      onClick={() => handleReplay(d.id)}
                      disabled={replayingId === d.id}
                      className="btn-primary text-xs px-2.5 py-1.5"
                    >
                      {replayingId === d.id ? "Replaying..." : "Replay"}
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {total > deadLetters.length && (
        <p className="text-xs text-[#8aaa8a] mt-2 font-body">
          Showing {deadLetters.length} of {total} dead-lettered deliveries.
        </p>
      )}

      <div className="mt-6">
        <button
          onClick={() => {
            setShowHistory((v) => !v);
            if (!showHistory) loadHistory();
          }}
          className="btn-secondary text-xs px-2.5 py-1.5"
        >
          {showHistory ? "Hide delivery history" : "Show delivery history"}
        </button>

        {showHistory && (
          <div className="overflow-x-auto card p-0 mt-4">
            <table className="min-w-full divide-y divide-forest-100 text-left text-sm font-body">
              <thead className="bg-forest-50 text-xs font-semibold uppercase text-forest-900">
                <tr>
                  <th className="px-6 py-3">Project</th>
                  <th className="px-6 py-3">Event Type</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Attempts</th>
                  <th className="px-6 py-3">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-forest-100 bg-white dark:bg-zinc-900 text-forest-700">
                {historyLoading ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-4 text-center text-[#8aaa8a]">
                      Loading...
                    </td>
                  </tr>
                ) : history.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-6 py-4 text-center text-[#8aaa8a]">
                      No deliveries found.
                    </td>
                  </tr>
                ) : (
                  history.map((d) => (
                    <tr key={d.id} className="hover:bg-forest-50/50 transition-colors">
                      <td className="px-6 py-4 font-semibold text-forest-900">
                        {d.projectName || d.projectId}
                      </td>
                      <td className="px-6 py-4">{d.eventType}</td>
                      <td className="px-6 py-4">
                        <span
                          className={`badge text-xs ${STATUS_BADGES[d.status]}`}
                        >
                          {d.status}
                        </span>
                      </td>
                      <td className="px-6 py-4">{d.attempts}</td>
                      <td className="px-6 py-4">{formatDate(d.createdAt)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
