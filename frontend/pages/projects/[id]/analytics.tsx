/**
 * pages/projects/[id]/analytics.tsx — Project Owner Impact Analytics
 *
 * Private analytics dashboard at /projects/[id]/analytics.
 * Access is restricted: only the project's wallet owner can view.
 * Non-owners receive a 403 error.
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import Link from "next/link";
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from "recharts";
import { fetchProjectAnalytics, fetchProject } from "@/lib/api";
import type { ProjectAnalytics } from "@/lib/api";
import { formatXLM, shortenAddress } from "@/utils/format";

const COLORS = ["#227239", "#4caf70", "#81c784", "#a5d6a7", "#c8e6c9"];

export default function ProjectAnalyticsPage() {
  const router = useRouter();
  const { id } = router.query;

  const [analytics, setAnalytics] = useState<ProjectAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [daysFilter, setDaysFilter] = useState<30 | 90 | 365>(90);

  useEffect(() => {
    // Retrieve connected wallet from localStorage (set by WalletConnect)
    const stored = localStorage.getItem("stellarPublicKey");
    if (stored) {
      try {
        const parsed = JSON.parse(stored);
        setWalletAddress(parsed.publicKey || null);
      } catch {
        setWalletAddress(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!id || !walletAddress) return;

    setLoading(true);
    setError(null);

    fetchProjectAnalytics(id as string, walletAddress)
      .then((data) => {
        setAnalytics(data);
        setIsOwner(true);
      })
      .catch((err) => {
        if (err?.response?.status === 403) {
          setError("You must be the project owner to view analytics.");
          setIsOwner(false);
        } else if (err?.response?.status === 404) {
          setError("Project not found.");
        } else if (err?.response?.status === 429) {
          setError("Rate limit exceeded. Please wait a moment and try again.");
        } else {
          setError("Failed to load analytics. Please try again.");
        }
      })
      .finally(() => setLoading(false));
  }, [id, walletAddress]);

  const filteredTimeline = analytics?.donationTimeline?.filter((d) => {
    if (daysFilter === 30) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      return new Date(d.date) >= cutoff;
    }
    if (daysFilter === 365) {
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 365);
      return new Date(d.date) >= cutoff;
    }
    return true; // 90 days (already filtered server-side)
  }) || [];

  // ── Loading state ──────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 animate-pulse">
        <Head><title>Analytics — Stellar IndigoPay</title></Head>
        <div className="h-8 bg-forest-200 rounded w-1/3 mb-6" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-forest-100 rounded-xl" />
          ))}
        </div>
        <div className="h-64 bg-forest-100 rounded-xl mb-6" />
        <div className="h-48 bg-forest-100 rounded-xl" />
      </div>
    );
  }

  // ── Error state ────────────────────────────────────────────────────────
  if (error || !analytics) {
    return (
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
        <Head><title>Analytics — Stellar IndigoPay</title></Head>
        <Link
          href={`/projects/${id}`}
          className="inline-flex items-center gap-1 text-sm text-[#5a7a5a] hover:text-forest-700 mb-8"
        >
          ← Back to Project
        </Link>
        <div className="card text-center py-12">
          <div className="text-5xl mb-4">
            {error?.includes("403") || error?.includes("owner") ? "🔒" : "⚠️"}
          </div>
          <h1 className="font-display text-2xl font-bold text-forest-900 mb-2">
            {error || "Something went wrong"}
          </h1>
          <p className="text-[#5a7a5a] mb-6">
            {isOwner === false
              ? "Connect your project owner wallet to access analytics."
              : "Please check your connection and try again."}
          </p>
          {!walletAddress && (
            <Link href={`/projects/${id}`} className="btn-primary text-sm py-2 px-6">
              Go to Project Page
            </Link>
          )}
        </div>
      </div>
    );
  }

  // ── Analytics dashboard ────────────────────────────────────────────────
  const { donorOverview, topDonors, donationDistribution, donorRetention, milestones, campaigns, ratingSummary } = analytics;

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 pb-16 animate-fade-in">
      <Head>
        <title>{analytics.projectName} Analytics — Stellar IndigoPay</title>
        <meta name="robots" content="noindex" />
      </Head>

      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 mb-8">
        <Link
          href={`/projects/${id}`}
          className="inline-flex items-center gap-1 text-sm text-[#5a7a5a] hover:text-forest-700 transition-colors"
        >
          ← Back to Project
        </Link>
        <h1 className="font-display text-2xl sm:text-3xl font-bold text-forest-900">
          📊 {analytics.projectName}
        </h1>
        <span className="text-xs px-3 py-1 rounded-full bg-forest-100 text-forest-700 border border-forest-200 font-bold">
          Analytics
        </span>
      </div>

      {/* ── Donor Overview Cards ────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-8">
        {[
          { icon: "👥", label: "Total Donors", value: donorOverview.totalDonors.toLocaleString() },
          { icon: "🆕", label: "New (30d)", value: donorOverview.newDonors30d.toLocaleString() },
          { icon: "💰", label: "Total Raised", value: formatXLM(donorOverview.totalRaisedXLM) },
          { icon: "📊", label: "Avg Donation", value: formatXLM(donorOverview.avgDonationXLM) },
          { icon: "🎯", label: "Median", value: formatXLM(donorOverview.medianDonationXLM) },
          { icon: "📝", label: "Total Donations", value: donorOverview.totalDonations.toLocaleString() },
        ].map((stat) => (
          <div
            key={stat.label}
            className="stat-card text-center p-4 bg-white border border-forest-100 rounded-xl shadow-sm hover:shadow-md transition-shadow"
          >
            <p className="text-xl mb-1">{stat.icon}</p>
            <p className="font-bold text-forest-900 text-lg">{stat.value}</p>
            <p className="text-xs text-[#8aaa8a] font-medium">{stat.label}</p>
          </div>
        ))}
      </div>

      {/* ── Donation Timeline ───────────────────────────────────────────── */}
      <div className="card mb-8">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h2 className="font-display text-lg font-semibold text-forest-900">
            Donation Timeline
          </h2>
          <div className="flex gap-1">
            {([30, 90, 365] as const).map((d) => (
              <button
                key={d}
                onClick={() => setDaysFilter(d)}
                className={`px-3 py-1 text-xs rounded-lg font-semibold transition-colors ${
                  daysFilter === d
                    ? "bg-forest-600 text-white"
                    : "bg-forest-50 text-forest-700 hover:bg-forest-100"
                }`}
              >
                {d}d
              </button>
            ))}
          </div>
        </div>
        {filteredTimeline.length === 0 ? (
          <div className="text-center py-12 text-[#8aaa8a]">
            <p className="text-4xl mb-2">📈</p>
            <p className="text-sm">No donation data for this period yet.</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <AreaChart data={filteredTimeline} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
              <defs>
                <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#227239" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#227239" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#e8f3e8" />
              <XAxis dataKey="date" tick={{ fontSize: 11, fill: "#8aaa8a" }} />
              <YAxis tick={{ fontSize: 11, fill: "#8aaa8a" }} />
              <Tooltip
                contentStyle={{ borderRadius: 12, border: "1px solid #c8dfc8", fontSize: 12 }}
                formatter={(value: number) => [formatXLM(String(value)), "Total"]}
              />
              <Area
                type="monotone"
                dataKey="total"
                stroke="#227239"
                strokeWidth={2}
                fill="url(#colorTotal)"
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* ── Distribution + Retention Row ─────────────────────────────────── */}
      <div className="grid md:grid-cols-2 gap-6 mb-8">
        {/* Donation Distribution */}
        <div className="card">
          <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
            Donation Size Distribution
          </h2>
          {donationDistribution.length === 0 ? (
            <div className="text-center py-12 text-[#8aaa8a]">
              <p className="text-3xl mb-2">📊</p>
              <p className="text-sm">No donation data yet.</p>
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={donationDistribution} margin={{ top: 5, right: 5, left: 5, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e8f3e8" />
                <XAxis dataKey="bucket" tick={{ fontSize: 11, fill: "#8aaa8a" }} />
                <YAxis tick={{ fontSize: 11, fill: "#8aaa8a" }} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: "1px solid #c8dfc8", fontSize: 12 }}
                />
                <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                  {donationDistribution.map((_, idx) => (
                    <Cell key={idx} fill={COLORS[idx % COLORS.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* Donor Retention */}
        <div className="card">
          <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
            Donor Retention
          </h2>
          <div className="flex flex-col items-center justify-center h-[220px]">
            <div className="relative w-36 h-36 mb-4">
              <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                <circle cx="18" cy="18" r="15.5" fill="none" stroke="#e8f3e8" strokeWidth="4" />
                <circle
                  cx="18"
                  cy="18"
                  r="15.5"
                  fill="none"
                  stroke="#227239"
                  strokeWidth="4"
                  strokeDasharray={`${donorRetention.retentionPct} ${100 - donorRetention.retentionPct}`}
                  strokeLinecap="round"
                />
              </svg>
              <div className="absolute inset-0 flex items-center justify-center">
                <span className="text-xl font-bold text-forest-900">
                  {donorRetention.retentionPct}%
                </span>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4 text-center">
              <div>
                <p className="text-2xl font-bold text-forest-900">
                  {donorRetention.returningDonors}
                </p>
                <p className="text-xs text-[#8aaa8a]">Returning</p>
              </div>
              <div>
                <p className="text-2xl font-bold text-[#5a7a5a]">
                  {donorRetention.oneTimeDonors}
                </p>
                <p className="text-xs text-[#8aaa8a]">One-time</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Top Donors ───────────────────────────────────────────────────── */}
      <div className="card mb-8">
        <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
          Top Donors
        </h2>
        {topDonors.length === 0 ? (
          <div className="text-center py-8 text-[#8aaa8a]">
            <p className="text-3xl mb-2">🏆</p>
            <p className="text-sm">No donors yet. Share your project to attract supporters.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left border-b border-forest-100">
                  <th className="py-3 px-3 text-xs font-semibold text-[#8aaa8a] uppercase">#</th>
                  <th className="py-3 px-3 text-xs font-semibold text-[#8aaa8a] uppercase">Donor</th>
                  <th className="py-3 px-3 text-xs font-semibold text-[#8aaa8a] uppercase text-right">
                    Total
                  </th>
                  <th className="py-3 px-3 text-xs font-semibold text-[#8aaa8a] uppercase text-right">
                    Donations
                  </th>
                </tr>
              </thead>
              <tbody>
                {topDonors.map((donor, idx) => (
                  <tr key={donor.donorAddress} className="border-b border-forest-50 hover:bg-forest-50/50">
                    <td className="py-3 px-3 font-bold text-forest-900">{idx + 1}</td>
                    <td className="py-3 px-3 font-mono text-xs text-forest-700">
                      {shortenAddress(donor.donorAddress || "")}
                    </td>
                    <td className="py-3 px-3 text-right font-semibold text-forest-900">
                      {formatXLM(donor.totalContributed)}
                    </td>
                    <td className="py-3 px-3 text-right text-[#5a7a5a]">
                      {donor.donationCount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Milestones ───────────────────────────────────────────────────── */}
      {milestones.length > 0 && (
        <div className="card mb-8">
          <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
            Milestone Progress
          </h2>
          <div className="space-y-4">
            {milestones.map((m) => (
              <div key={m.id}>
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold ${
                        m.reached
                          ? "bg-emerald-500 text-white"
                          : m.currentProgress >= 100
                            ? "bg-amber-400 text-white"
                            : "bg-forest-100 text-forest-700"
                      }`}
                    >
                      {m.percentage}%
                    </div>
                    <span className="text-sm font-semibold text-forest-900">{m.title}</span>
                  </div>
                  <span className="text-xs text-[#8aaa8a]">
                    {m.reached ? "✅ Reached" : `${m.currentProgress}%`}
                  </span>
                </div>
                <div className="w-full bg-forest-100 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full transition-all duration-700 rounded-full ${
                      m.reached ? "bg-emerald-500" : "bg-forest-500"
                    }`}
                    style={{ width: `${Math.min(m.currentProgress, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Campaigns ────────────────────────────────────────────────────── */}
      {campaigns.length > 0 && (
        <div className="card mb-8">
          <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
            Campaign Performance
          </h2>
          <div className="space-y-4">
            {campaigns.map((c) => (
              <div key={c.id} className="p-4 rounded-xl border border-forest-200 bg-forest-50">
                <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                  <p className="font-semibold text-forest-900">{c.title}</p>
                  <span
                    className={`text-xs px-2 py-1 rounded-full font-bold ${
                      c.status === "completed"
                        ? "bg-emerald-100 text-emerald-700 border border-emerald-200"
                        : c.status === "ended"
                          ? "bg-red-50 text-red-600 border border-red-200"
                          : "bg-amber-50 text-amber-700 border border-amber-200"
                    }`}
                  >
                    {c.status === "completed" ? "Completed" : c.status === "ended" ? "Ended" : "Active"}
                  </span>
                </div>
                <p className="text-xs text-[#5a7a5a] mb-2">
                  Deadline: {new Date(c.deadline).toLocaleDateString()}
                </p>
                <div className="flex justify-between text-xs mb-1">
                  <span>{formatXLM(c.raisedXLM)} raised</span>
                  <span>{c.progressPercent}% of {formatXLM(c.goalXLM)}</span>
                </div>
                <div className="w-full bg-forest-200 h-2 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      c.status === "completed" ? "bg-emerald-500" : "bg-forest-500"
                    }`}
                    style={{ width: `${Math.min(c.progressPercent, 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Rating Summary ───────────────────────────────────────────────── */}
      <div className="card mb-8">
        <h2 className="font-display text-lg font-semibold text-forest-900 mb-4">
          Rating Summary
        </h2>
        {ratingSummary.totalRatings === 0 ? (
          <div className="text-center py-8 text-[#8aaa8a]">
            <p className="text-3xl mb-2">⭐</p>
            <p className="text-sm">No ratings yet.</p>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row items-center gap-6">
            <div className="text-center">
              <p className="text-4xl font-bold text-forest-900">
                {ratingSummary.averageRating.toFixed(1)}
              </p>
              <div className="text-amber-400 text-lg">★ ★ ★ ★ ★</div>
              <p className="text-xs text-[#8aaa8a] mt-1">
                {ratingSummary.totalRatings} rating{ratingSummary.totalRatings !== 1 ? "s" : ""}
              </p>
            </div>
            <div className="flex-1 space-y-1.5 w-full">
              {[5, 4, 3, 2, 1].map((star) => {
                const count = ratingSummary.distribution[star] || 0;
                const maxCount = Math.max(...Object.values(ratingSummary.distribution), 1);
                const pct = (count / ratingSummary.totalRatings) * 100;
                return (
                  <div key={star} className="flex items-center gap-2">
                    <span className="text-xs w-4 text-right font-semibold text-[#8aaa8a]">
                      {star}
                    </span>
                    <span className="text-xs text-amber-400 w-4">★</span>
                    <div className="flex-1 h-2 bg-forest-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-amber-400 rounded-full"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-xs text-[#5a7a5a] w-8">{count}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Disable server-side rendering — analytics requires client-side wallet auth
export async function getServerSideProps() {
  return { props: {} };
}
