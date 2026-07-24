/**
 * components/admin/MatchManager.tsx — Match pools admin UI
 *
 * Allows administrators to manage (list, create, update, cancel/delete)
 * donation matching pools.
 */
import { useEffect, useState, useCallback } from "react";
import {
  listAdminMatches,
  createAdminMatch,
  updateAdminMatch,
  deleteAdminMatch,
  fetchProjects,
  type AdminMatchPool,
} from "@/lib/api";
import type { ClimateProject } from "@/utils/types";
import { formatDate, formatXLM, shortenAddress } from "@/utils/format";

interface MatchManagerProps {
  adminKey: string;
}

export default function MatchManager({ adminKey }: MatchManagerProps) {
  const [matches, setMatches] = useState<AdminMatchPool[]>([]);
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Form State
  const [projectId, setProjectId] = useState("");
  const [matcherAddress, setMatcherAddress] = useState("");
  const [capXLM, setCapXLM] = useState("");
  const [multiplier, setMultiplier] = useState("2");
  const [expiresAt, setExpiresAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const loadMatches = useCallback(() => {
    setLoading(true);
    setError(null);
    listAdminMatches()
      .then(setMatches)
      .catch((e: unknown) =>
        setError((e as Error).message || "Failed to load match pools")
      )
      .finally(() => setLoading(false));
  }, []);

  const loadProjects = useCallback(() => {
    fetchProjects({ limit: 100 })
      .then(setProjects)
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadMatches();
    loadProjects();
  }, [loadMatches, loadProjects]);

  const handleCreateMatch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!projectId || !matcherAddress || !capXLM || !expiresAt) {
      setError("Please fill out all fields");
      return;
    }
    setError(null);
    setSuccessMsg(null);
    setSubmitting(true);

    try {
      await createAdminMatch({
        projectId,
        matcherAddress,
        capXLM: parseFloat(capXLM),
        multiplier: parseInt(multiplier, 10),
        expiresAt: new Date(expiresAt).toISOString(),
      });
      setSuccessMsg("Match pool created successfully!");
      setProjectId("");
      setMatcherAddress("");
      setCapXLM("");
      setMultiplier("2");
      setExpiresAt("");
      loadMatches();
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to create match pool");
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancelMatch = async (id: string) => {
    if (!window.confirm("Are you sure you want to cancel this matching campaign?")) {
      return;
    }
    setError(null);
    try {
      await deleteAdminMatch(id);
      loadMatches();
    } catch (e: unknown) {
      setError((e as Error).message || "Failed to cancel match pool");
    }
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case "active":
        return "bg-emerald-50 text-emerald-700 border-emerald-200";
      case "expired":
        return "bg-amber-50 text-amber-700 border-amber-200";
      case "exhausted":
        return "bg-blue-50 text-blue-700 border-blue-200";
      case "cancelled":
        return "bg-red-50 text-red-700 border-red-200";
      default:
        return "bg-gray-50 text-gray-700 border-gray-200";
    }
  };

  return (
    <div className="border-t border-forest-100 pt-8 animate-fade-in">
      <div className="flex flex-col md:flex-row md:items-center justify-between mb-6 gap-4">
        <div>
          <h2 className="font-display text-xl font-bold text-forest-900">
            Donation Match Pools
          </h2>
          <p className="text-xs text-[#5a7a5a] dark:text-[#8aaa8a] font-body mt-0.5">
            Manage matching campaigns, set multiplier rules, and view remaining capacities.
          </p>
        </div>
      </div>

      {error && (
        <div className="card mb-4 border-red-200 bg-red-50 text-red-800 text-sm">
          {error}
        </div>
      )}

      {successMsg && (
        <div className="card mb-4 border-emerald-200 bg-emerald-50 text-emerald-800 text-sm">
          {successMsg}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        {/* Create Form */}
        <div className="card lg:col-span-1 border-forest-200 bg-forest-50/40">
          <h3 className="font-display font-semibold text-forest-900 mb-4 text-base">
            Create Match Pool
          </h3>
          <form onSubmit={handleCreateMatch} className="space-y-4 text-sm font-body">
            <div>
              <label className="block text-xs font-semibold text-forest-700 mb-1">
                Target Project
              </label>
              <select
                value={projectId}
                onChange={(e) => setProjectId(e.target.value)}
                className="w-full px-3 py-2 border border-forest-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-forest-400 bg-white"
                required
              >
                <option value="">Select project...</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-forest-700 mb-1">
                Matcher Address (Stellar G...)
              </label>
              <input
                type="text"
                placeholder="G..."
                value={matcherAddress}
                onChange={(e) => setMatcherAddress(e.target.value)}
                className="w-full px-3 py-2 border border-forest-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-forest-400 bg-white"
                required
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-forest-700 mb-1">
                  Cap (XLM)
                </label>
                <input
                  type="number"
                  placeholder="e.g. 10000"
                  value={capXLM}
                  onChange={(e) => setCapXLM(e.target.value)}
                  className="w-full px-3 py-2 border border-forest-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-forest-400 bg-white"
                  min="0.0000001"
                  step="any"
                  required
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-forest-700 mb-1">
                  Multiplier
                </label>
                <select
                  value={multiplier}
                  onChange={(e) => setMultiplier(e.target.value)}
                  className="w-full px-3 py-2 border border-forest-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-forest-400 bg-white"
                  required
                >
                  <option value="1">1×</option>
                  <option value="2">2×</option>
                  <option value="3">3×</option>
                  <option value="4">4×</option>
                  <option value="5">5×</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-forest-700 mb-1">
                Expiry Date
              </label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 border border-forest-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-forest-400 bg-white"
                required
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="btn-primary w-full text-center py-2"
            >
              {submitting ? "Creating..." : "Create Pool"}
            </button>
          </form>
        </div>

        {/* Matches List Table */}
        <div className="lg:col-span-2 card p-0 overflow-hidden flex flex-col justify-between">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-forest-100 text-left text-sm font-body">
              <thead className="bg-forest-50 text-xs font-semibold uppercase text-forest-900">
                <tr>
                  <th className="px-6 py-3">Project</th>
                  <th className="px-6 py-3">Matcher</th>
                  <th className="px-6 py-3">Multiplier</th>
                  <th className="px-6 py-3">Remaining / Cap</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-forest-100 bg-white dark:bg-zinc-900 text-forest-700">
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-[#8aaa8a]">
                      Loading match pools...
                    </td>
                  </tr>
                ) : matches.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-8 text-center text-[#8aaa8a]">
                      No donation match pools configured.
                    </td>
                  </tr>
                ) : (
                  matches.map((m) => (
                    <tr key={m.id} className="hover:bg-forest-50/50 transition-colors">
                      <td className="px-6 py-4 font-semibold text-forest-900 max-w-[150px] truncate">
                        {m.projectName || m.projectId}
                      </td>
                      <td className="px-6 py-4 text-xs font-mono">
                        {shortenAddress(m.matcherAddress)}
                      </td>
                      <td className="px-6 py-4 font-semibold text-indigo-600">
                        {m.multiplier}×
                      </td>
                      <td className="px-6 py-4">
                        <div className="text-xs">
                          {formatXLM(m.remainingXLM)} / {formatXLM(m.capXLM)}
                        </div>
                        <div className="w-24 h-1.5 bg-forest-100 rounded-full overflow-hidden mt-1.5">
                          <div
                            className="h-full bg-forest-600 rounded-full"
                            style={{ width: `${m.progressPct}%` }}
                          />
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`badge text-xs ${getStatusBadgeClass(m.status)}`}>
                          {m.status}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-right">
                        {m.status === "active" && (
                          <button
                            onClick={() => handleCancelMatch(m.id)}
                            className="btn-secondary text-xs px-2.5 py-1 text-red-600 border-red-200 hover:bg-red-50"
                          >
                            Cancel
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
