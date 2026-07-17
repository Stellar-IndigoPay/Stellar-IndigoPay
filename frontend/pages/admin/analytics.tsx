/**
 * pages/admin/analytics.tsx — Admin Analytics Dashboard
 *
 * Comprehensive analytics dashboard with summary cards, charts, tables,
 * and CSV/JSON export. Requires admin authentication via publicKey.
 */
import { useState, useEffect, useCallback } from "react";
import {
  ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  AreaChart, Area,
  PieChart, Pie, Cell, Legend,
} from "recharts";
import WalletConnect from "@/components/WalletConnect";
import Link from "next/link";
import {
  fetchAdminDonationTrends, fetchAdminProjectPerformance,
  fetchAdminGeographicImpact, fetchAdminDonorRetention,
  fetchAdminCategoryBreakdown, fetchAdminPlatformGrowth,
  exportAdminAnalytics,
  type AdminDonationTrend, type AdminProjectPerformance,
  type AdminGeographicImpact, type AdminDonorRetention,
  type AdminCategoryBreakdown, type AdminGrowthData,
} from "@/lib/api";

const COLORS = ["#4F46E5", "#10B981", "#F59E0B", "#EF4444", "#8B5CF6", "#EC4899", "#06B6D4", "#84CC16"];

const RANGES: Record<string, { label: string; days: number }> = {
  "30d": { label: "30 days", days: 30 },
  "90d": { label: "90 days", days: 90 },
  "180d": { label: "6 months", days: 180 },
  "365d": { label: "1 year", days: 365 },
  all: { label: "All time", days: 0 },
};

interface Props {
  publicKey: string | null;
  onConnect: (pk: string) => void;
}

export default function AdminAnalyticsPage({ publicKey, onConnect }: Props) {
  const [range, setRange] = useState("90d");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [trends, setTrends] = useState<AdminDonationTrend[]>([]);
  const [projects, setProjects] = useState<AdminProjectPerformance[]>([]);
  const [geographic, setGeographic] = useState<AdminGeographicImpact[]>([]);
  const [retention, setRetention] = useState<AdminDonorRetention[]>([]);
  const [categories, setCategories] = useState<AdminCategoryBreakdown[]>([]);
  const [growth, setGrowth] = useState<AdminGrowthData | null>(null);
  const [sortKey, setSortKey] = useState<keyof AdminProjectPerformance>("raisedXLM");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const loadData = useCallback(async () => {
    if (!publicKey) return;
    setLoading(true);
    setError(null);

    const r = RANGES[range];
    const dateRange = r.days > 0
      ? {
          from: new Date(Date.now() - r.days * 86400000).toISOString().slice(0, 10),
          to: new Date().toISOString().slice(0, 10),
        }
      : {};

    try {
      const [td, pp, gi, dr, cb, pg] = await Promise.all([
        fetchAdminDonationTrends(publicKey, dateRange),
        fetchAdminProjectPerformance(publicKey),
        fetchAdminGeographicImpact(publicKey),
        fetchAdminDonorRetention(publicKey),
        fetchAdminCategoryBreakdown(publicKey, dateRange),
        fetchAdminPlatformGrowth(publicKey),
      ]);
      setTrends(td);
      setProjects(pp);
      setGeographic(gi);
      setRetention(dr);
      setCategories(cb);
      setGrowth(pg);
    } catch (e) {
      setError((e as Error).message || "Failed to load analytics");
    } finally {
      setLoading(false);
    }
  }, [publicKey, range]);

  useEffect(() => { loadData(); }, [loadData]);

  const handleExport = async (view: string, format: "csv" | "json") => {
    if (!publicKey) return;
    try {
      const r = RANGES[range];
      const dateRange = r.days > 0
        ? { from: new Date(Date.now() - r.days * 86400000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }
        : {};
      await exportAdminAnalytics(publicKey, view, format, dateRange);
    } catch (e) {
      setError("Export failed: " + (e as Error).message);
    }
  };

  const sortedProjects = [...projects].sort((a, b) => {
    const aNum = typeof a[sortKey] === "number" ? (a[sortKey] as number) : parseFloat(String(a[sortKey])) || 0;
    const bNum = typeof b[sortKey] === "number" ? (b[sortKey] as number) : parseFloat(String(b[sortKey])) || 0;
    return sortDir === "desc" ? bNum - aNum : aNum - bNum;
  });

  const handleSort = (key: keyof AdminProjectPerformance) => {
    if (sortKey === key) {
      setSortDir(sortDir === "desc" ? "asc" : "desc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  // Admin auth gate
  if (!publicKey) {
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl font-bold text-forest-900 mb-3">
            Analytics Dashboard
          </h1>
          <p className="text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
            Connect your admin wallet to view platform analytics.
          </p>
        </div>
        <WalletConnect onConnect={onConnect} />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10">
        <div className="animate-pulse space-y-6">
          <div className="h-8 bg-forest-100 rounded w-64" />
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[1, 2, 3, 4].map((i) => <div key={i} className="h-28 bg-forest-50 rounded-2xl" />)}
          </div>
          <div className="h-80 bg-forest-50 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between mb-8 gap-4">
        <div>
          <div className="flex items-center gap-3 mb-1">
            <Link href="/admin" className="text-xs text-[#8aaa8a] hover:text-forest-700 font-body">← Admin</Link>
            <p className="text-xs tracking-[0.22em] uppercase text-[#8aaa8a] dark:text-forest-300 font-body">Admin</p>
          </div>
          <h1 className="font-display text-3xl font-bold text-forest-900">Analytics Dashboard</h1>
        </div>
        <div className="flex items-center gap-3">
          <select value={range} onChange={(e) => setRange(e.target.value)} className="rounded-lg border border-forest-200 bg-white dark:bg-zinc-900 px-3 py-2 text-sm font-body text-forest-700">
            {Object.entries(RANGES).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>
          <button onClick={loadData} className="btn-secondary text-xs px-3 py-2">Refresh</button>
          <button onClick={() => handleExport("growth", "json")} className="btn-secondary text-xs px-3 py-2">Export JSON</button>
          <button onClick={() => handleExport("trends", "csv")} className="btn-secondary text-xs px-3 py-2">Export CSV</button>
        </div>
      </div>

      {error && <div className="card mb-6 border-red-200"><p className="text-red-600 font-body">{error}</p></div>}

      {growth && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[
            { label: "Total Raised", value: `${(parseFloat(growth.summary.totalXLM) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })} XLM` },
            { label: "Total Donors", value: growth.summary.totalDonors.toLocaleString() },
            { label: "Total Projects", value: growth.summary.totalProjects.toLocaleString() },
            { label: "Active Donors (30d)", value: growth.summary.activeDonors30d.toLocaleString() },
          ].map((card) => (
            <div key={card.label} className="card bg-gradient-to-br from-forest-50 to-emerald-50 dark:from-zinc-800 dark:to-zinc-900 rounded-2xl p-5">
              <p className="text-xs text-[#8aaa8a] font-body uppercase tracking-wide">{card.label}</p>
              <p className="text-2xl font-display font-bold text-forest-900 mt-1">{card.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Donation Trends */}
      <section className="card rounded-2xl mb-8">
        <h2 className="font-display text-lg font-bold text-forest-900 mb-4">Donation Trends</h2>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={trends}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
              <XAxis dataKey="day" tick={{ fontSize: 11 }} interval="preserveStartEnd" />
              <YAxis yAxisId="left" tick={{ fontSize: 11 }} />
              <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 11 }} />
              <Tooltip />
              <Line yAxisId="left" type="monotone" dataKey="totalXLM" stroke="#4F46E5" strokeWidth={2} dot={false} name="XLM" />
              <Line yAxisId="right" type="monotone" dataKey="uniqueDonors" stroke="#10B981" strokeWidth={2} dot={false} name="Donors" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
        <section className="card rounded-2xl">
          <h2 className="font-display text-lg font-bold text-forest-900 mb-4">Category Breakdown</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={categories} dataKey="totalXLM" nameKey="category" cx="50%" cy="50%" outerRadius={90} label={({ category }) => category}>
                  {categories.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                </Pie>
                <Tooltip />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </section>

        <section className="card rounded-2xl">
          <h2 className="font-display text-lg font-bold text-forest-900 mb-4">Geographic Impact</h2>
          <div className="overflow-x-auto max-h-72">
            <table className="min-w-full text-left text-sm font-body">
              <thead className="text-xs font-semibold uppercase text-forest-500 sticky top-0 bg-white dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2">Country</th>
                  <th className="px-4 py-2 text-right">XLM</th>
                  <th className="px-4 py-2 text-right">Projects</th>
                  <th className="px-4 py-2 text-right">Donors</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-forest-50">
                {geographic.slice(0, 15).map((g) => (
                  <tr key={g.country} className="hover:bg-forest-50/50">
                    <td className="px-4 py-2 font-medium text-forest-800">{g.country}</td>
                    <td className="px-4 py-2 text-right">{Number(g.totalXLM).toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">{g.projectCount}</td>
                    <td className="px-4 py-2 text-right">{g.donorCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      {growth && (
        <section className="card rounded-2xl mb-8">
          <h2 className="font-display text-lg font-bold text-forest-900 mb-4">Platform Growth</h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={growth.monthlyGrowth}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.08)" />
                <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Area type="monotone" dataKey="donations" stroke="#4F46E5" fill="rgba(79,70,229,0.12)" name="Donations" />
                <Area type="monotone" dataKey="donors" stroke="#10B981" fill="rgba(16,185,129,0.08)" name="Donors" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </section>
      )}

      <section className="card rounded-2xl mb-8">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-lg font-bold text-forest-900">Project Performance</h2>
          <button onClick={() => handleExport("projects", "json")} className="btn-secondary text-xs px-3 py-1.5">Export</button>
        </div>
        <div className="overflow-x-auto max-h-96">
          <table className="min-w-full text-left text-sm font-body">
            <thead className="text-xs font-semibold uppercase text-forest-500 sticky top-0 bg-white dark:bg-zinc-900">
              <tr>
                {(["name", "category", "raisedXLM", "donorCount", "progressPct", "co2OffsetKg", "totalDonations"] as const).map((key) => (
                  <th key={key} className="px-4 py-2 cursor-pointer hover:text-forest-700" onClick={() => handleSort(key)}>
                    {key === "raisedXLM" ? "Raised" : key === "donorCount" ? "Donors" : key === "progressPct" ? "Progress" : key === "co2OffsetKg" ? "CO₂ kg" : key === "totalDonations" ? "Donations" : key === "name" ? "Project" : "Category"}
                    {sortKey === key && (sortDir === "desc" ? " ↓" : " ↑")}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-forest-50">
              {sortedProjects.slice(0, 50).map((p) => (
                <tr key={p.id} className="hover:bg-forest-50/50">
                  <td className="px-4 py-2 font-medium text-forest-800 max-w-[200px] truncate">{p.name}</td>
                  <td className="px-4 py-2"><span className="badge bg-forest-50 text-forest-700 text-xs">{p.category}</span></td>
                  <td className="px-4 py-2 text-right">{Number(p.raisedXLM).toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{p.donorCount}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-2 bg-forest-100 rounded-full overflow-hidden">
                        <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${Math.min(p.progressPct, 100)}%` }} />
                      </div>
                      <span className="text-xs">{p.progressPct}%</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right">{p.co2OffsetKg.toLocaleString()}</td>
                  <td className="px-4 py-2 text-right">{p.totalDonations}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card rounded-2xl">
        <h2 className="font-display text-lg font-bold text-forest-900 mb-4">Donor Retention Cohorts</h2>
        <div className="overflow-x-auto max-h-72">
          <table className="min-w-full text-left text-sm font-body">
            <thead className="text-xs font-semibold uppercase text-forest-500 sticky top-0 bg-white dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2">Cohort</th>
                <th className="px-4 py-2 text-right">Size</th>
                <th className="px-4 py-2">Activity</th>
                <th className="px-4 py-2 text-right">Active</th>
                <th className="px-4 py-2 text-right">Retention</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-forest-50">
              {retention.slice(0, 50).map((r, i) => (
                <tr key={`${r.cohortMonth}-${r.activityMonth}-${i}`} className="hover:bg-forest-50/50">
                  <td className="px-4 py-2 font-medium">{r.cohortMonth}</td>
                  <td className="px-4 py-2 text-right">{r.cohortSize}</td>
                  <td className="px-4 py-2">{r.activityMonth}</td>
                  <td className="px-4 py-2 text-right">{r.activeDonors}</td>
                  <td className="px-4 py-2 text-right">
                    <span className={`font-semibold ${r.retentionPct >= 50 ? "text-emerald-600" : r.retentionPct >= 25 ? "text-amber-600" : "text-red-600"}`}>{r.retentionPct}%</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
