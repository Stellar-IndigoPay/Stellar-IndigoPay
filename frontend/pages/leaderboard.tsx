/**
 * pages/leaderboard.tsx — Top donors ranked by total XLM given
 */
import { useState } from "react";
import { useRouter } from "next/router";
import LeaderboardTable from "@/components/LeaderboardTable";
import Link from "next/link";
import PageMeta from "@/components/PageMeta";

type Period = "all" | "month" | "year";

export default function LeaderboardPage() {
  const router = useRouter();
  const period = (router.query.period as Period) || "all";

  const setPeriod = (newPeriod: Period) => {
    router.push(`/leaderboard?period=${newPeriod}`, undefined, {
      shallow: true,
    });
  };

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "https://stellar-indigopay.app";
  const canonicalUrl = `${appUrl}${router.asPath.split("?")[0]}`;
  const leaderboardJsonLd = {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name: "Top Climate Donors | Stellar IndigoPay",
    url: canonicalUrl,
    description:
      "See the leading climate donors and their impact badges on Stellar IndigoPay.",
  };

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      <PageMeta
        title="Top Climate Donors | Stellar IndigoPay"
        description="See the leading climate donors and their impact badges on Stellar IndigoPay."
        canonicalUrl={canonicalUrl}
        jsonLd={leaderboardJsonLd}
      />
      <div className="text-center mb-10">
        <div className="text-5xl mb-4">🏆</div>
        <h1 className="font-display text-3xl sm:text-4xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-3">
          Top Climate Donors
        </h1>
        <p className="text-[#475569] dark:text-[#94A3B8] max-w-xl mx-auto font-body leading-relaxed">
          Celebrating the community members who are driving the most impact.
          Every XLM donated is recorded permanently on the Stellar blockchain.
        </p>
      </div>

      {/* Badge legend */}
      <div className="card mb-8 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
        <p className="font-display font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-3 text-center">
          Impact Badge Tiers
        </p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[
            { emoji: "🌱", name: "Seedling", req: "10+ XLM" },
            { emoji: "🌳", name: "Tree", req: "100+ XLM" },
            { emoji: "🌲", name: "Forest", req: "500+ XLM" },
            { emoji: "🌍", name: "Earth Guardian", req: "2,000+ XLM" },
          ].map((b) => (
            <div
              key={b.name}
              className="bg-white dark:bg-[#14142D] rounded-xl p-3 border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
            >
              <p className="text-2xl mb-1">{b.emoji}</p>
              <p className="text-xs font-semibold text-[#0F172A] dark:text-[#E2E8F0] font-body">
                {b.name}
              </p>
              <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
                {b.req}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Period tabs */}
      <div className="mb-8 flex gap-2 justify-center">
        {[
          { key: "month", label: "This Month" },
          { key: "year", label: "This Year" },
          { key: "all", label: "All Time" },
        ].map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key as Period)}
            className={`px-4 py-2 rounded-lg font-body font-semibold transition-all ${
              period === p.key
                ? "btn-primary text-white border-0"
                : "bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] text-[#0F172A] dark:text-[#E2E8F0] hover:bg-[rgba(99,102,241,0.10)] dark:hover:bg-[rgba(129,140,248,0.12)] border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)]"
            }`}
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <LeaderboardTable limit={50} period={period} />

      <div className="mt-10 text-center">
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-4 font-body">
          Want to see your name here?
        </p>
        <Link href="/projects" className="btn-primary">
          🌱 Start Donating
        </Link>
        <div className="mt-4">
          <Link
            href="/leaderboard/history"
            className="text-[#4F46E5] dark:text-[#818CF8] text-sm underline"
          >
            🏅 View Donor of the Month history
          </Link>
        </div>
      </div>
    </div>
  );
}
