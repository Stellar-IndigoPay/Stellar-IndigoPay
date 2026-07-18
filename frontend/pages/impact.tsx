/**
 * pages/impact.tsx
 * Global Impact Dashboard — Querying aggregated data from backend API.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import AnimatedNumber from "@/components/AnimatedNumber";
import PageMeta from "@/components/PageMeta";
import DonationTicker from "@/components/DonationTicker";
import WorldMap from "@/components/WorldMap";
import { fetchImpactGlobal, fetchLeaderboard, fetchProjects } from "@/lib/api";
import { getGlobalImpactStats } from "@/lib/stellar";
import { formatCO2, formatXLM, shortenAddress } from "@/utils/format";
import type { LeaderboardEntry } from "@/utils/types";
import type { ImpactGlobalStats } from "@/lib/api";
import ImpactSkeleton from "@/components/ImpactSkeleton";

export default function ImpactPage() {
  const router = useRouter();
  const [stats, setStats] = useState<ImpactGlobalStats | null>(null);
  const [sorobanStats, setSorobanStats] = useState<{
    totalRaisedXLM: string;
    totalCO2OffsetGrams: string;
    donationCount: number;
  } | null>(null);
  const [projectCount, setProjectCount] = useState(0);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    async function loadData() {
      try {
        const [impactStats, topDonors, sorobanData, allProjects] =
          await Promise.all([
            fetchImpactGlobal(),
            fetchLeaderboard(3),
            getGlobalImpactStats(),
            fetchProjects(),
          ]);
        setStats(impactStats);
        setLeaderboard(topDonors);
        setSorobanStats(sorobanData);
        setProjectCount(allProjects.length);
      } catch (err) {
        console.error("Failed to load impact data:", err);
      } finally {
        setIsLoading(false);
      }
    }
    loadData();
  }, []);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://stellar-indigopay.app";
  const canonicalUrl = `${appUrl}${router.asPath.split("?")[0]}`;
  const impactJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Global Impact | Stellar IndigoPay",
    url: canonicalUrl,
    description: "Witness the real-time community impact of Stellar IndigoPay donors.",
  };

  if (isLoading) return <ImpactSkeleton />;

  return (
    <div className="min-h-screen bg-[#FAFAFE] dark:bg-[#0A0A1A] font-body text-[#0F172A] dark:text-[#E2E8F0] pb-20">
      <PageMeta
        title="Global Impact | Stellar IndigoPay"
        description="Witness the real-time community impact of Stellar IndigoPay donors."
        canonicalUrl={canonicalUrl}
        jsonLd={impactJsonLd}
      />

      <main className="max-w-7xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* Header Section */}
        <div className="text-center mb-16">
          <h1 className="text-4xl md:text-6xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] tracking-tight leading-tight">
            Our <span className="text-gradient">Global Impact</span>
          </h1>
          <p className="mt-4 text-lg text-[#4F46E5] dark:text-[#818CF8] max-w-2xl mx-auto">
            Transparency on-chain. Witness what the community has achieved
            together for our planet.
          </p>
        </div>

        {/* Global Stats Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-16">
          <StatCard
            label="XLM Donated"
            icon="✨"
            value={sorobanStats?.totalRaisedXLM ?? "0"}
            unit="XLM"
            isLoading={isLoading}
          />
          <StatCard
            label="CO₂ Offset"
            icon="🌿"
            value={
              sorobanStats ? Number(sorobanStats.totalCO2OffsetGrams) / 1000 : 0
            }
            unit="Kg"
            isLoading={isLoading}
            formatter={(val) => formatCO2(Math.floor(val))}
          />
          <StatCard
            label="Unique Donors"
            icon="💝"
            value={stats?.donorCount ?? 0}
            isLoading={isLoading}
          />
          <StatCard
            label="Projects"
            icon="🌍"
            value={projectCount}
            isLoading={isLoading}
          />
          <StatCard
            label="Trees Equivalent"
            icon="🌲"
            value={stats?.treesEquivalent ?? 0}
            isLoading={isLoading}
          />
        </div>

        {/* Interactive World Map Section */}
        <div className="card rounded-3xl p-8 mb-16">
          <h2 className="text-2xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-6 flex items-center gap-2">
            🗺️ Global Reach
          </h2>
          <WorldMap />
        </div>

        {/* Category Breakdown */}
        <div className="card rounded-3xl p-8 mb-16">
          <h2 className="text-2xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-6 flex items-center gap-2">
            📊 Impact by Category
          </h2>
          {stats?.breakdownByCategory?.length ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {stats.breakdownByCategory.map((row) => (
                <div
                  key={row.category}
                  className="flex items-center justify-between rounded-2xl border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] p-5"
                >
                  <div className="min-w-0">
                    <p className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] truncate">
                      {row.category}
                    </p>
                    <p className="text-xs text-[#4F46E5] dark:text-[#818CF8] mt-1">
                      {row.donorCount} donor{row.donorCount !== 1 ? "s" : ""} •{" "}
                      {formatCO2(row.co2OffsetKg)}
                    </p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="font-mono font-semibold text-[#4F46E5] dark:text-[#818CF8]">
                      {formatXLM(row.totalDonationsXLM)}
                    </p>
                    <p className="text-[11px] text-[#64748B]">donated</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-forest-500 text-sm">
              No category breakdown available yet.
            </p>
          )}
        </div>

        {/* Leaderboard Section */}
        <div className="card rounded-3xl shadow-indigo p-8 mb-16 relative overflow-hidden group">
          <div className="absolute top-0 right-0 w-32 h-32 bg-[rgba(99,102,241,0.06)] rounded-bl-full -z-0 opacity-50 group-hover:scale-110 transition-transform duration-500" />
          <h2 className="text-2xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-8 relative z-10 flex items-center gap-2">
            🏆 Top Impact Leaders
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 relative z-10">
            {leaderboard.length > 0 ? (
              leaderboard.map((entry, idx) => (
                <div
                  key={entry.publicKey}
                  className="flex flex-col items-center text-center p-6 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] rounded-2xl hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-colors border border-transparent hover:border-[rgba(99,102,241,0.15)] dark:hover:border-[rgba(129,140,248,0.20)]"
                >
                  <div className="w-12 h-12 rounded-full bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] text-white flex items-center justify-center font-bold mb-4 shadow-lg">
                    #{idx + 1}
                  </div>
                  <span className="font-bold text-lg text-[#0F172A] dark:text-[#E2E8F0] break-all">
                    {entry.displayName || shortenAddress(entry.publicKey)}
                  </span>
                  <p className="text-[#4F46E5] dark:text-[#818CF8] text-sm mt-1">
                    {entry.totalDonatedXLM} XLM Total
                  </p>
                  <div className="mt-4 px-3 py-1 rounded-full bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] text-[#4F46E5] dark:text-[#818CF8] text-xs font-bold uppercase tracking-wider">
                    {entry.topBadge || "Seedling"}
                  </div>
                </div>
              ))
            ) : (
              <p className="col-span-3 text-center text-[#64748B] dark:text-[#94A3B8] py-10">
                No leaderboard data available yet.
              </p>
            )}
          </div>
        </div>

        {/* Community Call-to-Action */}
        <div className="text-center py-10">
          <h3 className="text-2xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-4">
            Ready to make an impact?
          </h3>
          <button
            className="btn-primary px-8 py-3 text-lg"
            onClick={() => (window.location.href = "/projects")}
          >
            View Climate Projects
          </button>
        </div>
      </main>

      <DonationTicker />
    </div>
  );
}

function StatCard({
  label,
  icon,
  value,
  unit,
  isLoading,
  formatter,
}: {
  label: string;
  icon: string;
  value: string | number;
  unit?: string;
  isLoading: boolean;
  formatter?: (val: number) => string;
}) {
  return (
    <div className="card rounded-3xl p-8 hover:shadow-indigo transition-all relative group">
      <div className="w-12 h-12 rounded-2xl bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-2xl mb-6 group-hover:scale-110 transition-transform">
        {icon}
      </div>
      <p className="text-[#4F46E5] dark:text-[#818CF8] font-medium text-sm uppercase tracking-wider mb-2">
        {label}
      </p>
      <div className="text-4xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] flex items-baseline gap-1.5">
        {!isLoading ? (
          <AnimatedNumber value={value} formatter={formatter} />
        ) : (
          <span className="w-24 h-8 bg-forest-50 animate-pulse rounded" />
        )}
        {unit && (
          <span className="text-xl text-forest-400 font-normal">{unit}</span>
        )}
      </div>
    </div>
  );
}
