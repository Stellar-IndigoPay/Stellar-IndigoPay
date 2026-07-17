/**
 * pages/index.tsx — IndigoPay landing page
 */
import Link from "next/link";
import Head from "next/head";
import { useState, useRef, useEffect } from "react";
import WalletConnect from "@/components/WalletConnect";
import { useCountUp } from "@/hooks/useCountUp";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import {
  fetchGlobalStats,
  fetchFeaturedProject,
  fetchProjects,
  fetchCategoryStats,
} from "@/lib/api";
import { streamGlobalProjectDonations } from "@/lib/stellar";
import { formatCO2, formatXLM, progressPercent } from "@/utils/format";
import type { GlobalStats, CategoryStats } from "@/lib/api";
import type { ClimateProject } from "@/utils/types";

interface HomeProps {
  publicKey: string | null;
  onConnect: (pk: string) => void;
}

interface LiveDonationTickerItem {
  id: string;
  projectId: string;
  projectName: string;
  amountXLM: string;
  createdAt: string;
}

const FEATURES = [
  {
    icon: "🔗",
    title: "Direct to Project",
    desc: "Your XLM goes straight to the project wallet — no platform takes a cut.",
  },
  {
    icon: "🔍",
    title: "Full Transparency",
    desc: "Every donation is recorded on Stellar and tracked by a Soroban smart contract.",
  },
  {
    icon: "⚡",
    title: "Instant Settlement",
    desc: "Donations confirm in 3–5 seconds anywhere in the world for near-zero fees.",
  },
  {
    icon: "🏆",
    title: "Impact Badges",
    desc: "Earn on-chain badges as you give more — Seedling, Tree, Forest, Earth Guardian.",
  },
];

const FALLBACK_IMPACT_STATS = [
  { value: 0, suffix: "%", label: "Platform fees", duration: 1500 },
  {
    value: 100,
    prefix: ">",
    suffix: "%",
    label: "Direct to Project",
    duration: 2000,
  },
  { value: 5000, suffix: "+", label: "Monthly Donors", duration: 2500 },
  { value: 250000, label: "CO₂ Offset (kg)", duration: 3000 },
];

function buildHeroStats(stats: GlobalStats | null) {
  if (!stats) return FALLBACK_IMPACT_STATS;

  return [
    {
      value: Number.parseFloat(stats.totalXLMRaised) || 0,
      suffix: " XLM",
      label: "Total Raised",
      duration: 2200,
    },
    {
      value: stats.totalCO2OffsetKg,
      label: "CO₂ Offset (kg)",
      duration: 2500,
    },
    {
      value: stats.totalDonations,
      label: "Donations",
      duration: 2000,
    },
    {
      value: stats.totalProjects,
      label: "Projects",
      duration: 1800,
    },
  ];
}

const CATEGORIES = [
  { icon: "🌳", label: "Reforestation" },
  { icon: "☀️", label: "Solar Energy" },
  { icon: "🌊", label: "Ocean Conservation" },
  { icon: "💧", label: "Clean Water" },
  { icon: "🦁", label: "Wildlife Protection" },
  { icon: "♻️", label: "Carbon Capture" },
];

// Helper to get icon for a category
function getCategoryIcon(category: string): string {
  const match = CATEGORIES.find((c) => c.label === category);
  return match ? match.icon : "📁";
}

export default function Home({ publicKey, onConnect }: HomeProps) {
  const [showConnect, setShowConnect] = useState(false);
  const [globalStats, setGlobalStats] = useState<GlobalStats | null>(null);
  const [featuredProject, setFeaturedProject] = useState<ClimateProject | null>(
    null,
  );
  const [categoryStats, setCategoryStats] = useState<CategoryStats[]>([]);
  const [liveDonations, setLiveDonations] = useState<LiveDonationTickerItem[]>(
    [],
  );
  const [tickerIndex, setTickerIndex] = useState(0);

  useEffect(() => {
    let closeStream: (() => void) | null = null;
    let isMounted = true;

    fetchGlobalStats()
      .then(setGlobalStats)
      .catch(() => null);
    fetchFeaturedProject()
      .then(setFeaturedProject)
      .catch(() => null);
    fetchCategoryStats()
      .then(setCategoryStats)
      .catch(() => null);

    fetchProjects({ limit: 100 })
      .then((projects) => {
        if (!isMounted || projects.length === 0) return;
        closeStream = streamGlobalProjectDonations(
          projects.map((project) => ({
            id: project.id,
            name: project.name,
            walletAddress: project.walletAddress,
          })),
          (donation) => {
            setLiveDonations((prev) =>
              [
                {
                  id: donation.id,
                  projectId: donation.projectId,
                  projectName: donation.projectName,
                  amountXLM: donation.amountXLM,
                  createdAt: donation.createdAt,
                },
                ...prev.filter((item) => item.id !== donation.id),
              ].slice(0, 10),
            );
          },
        );
      })
      .catch(() => null);

    return () => {
      isMounted = false;
      if (closeStream) closeStream();
    };
  }, []);

  useEffect(() => {
    if (liveDonations.length <= 1) return;
    const timer = window.setInterval(() => {
      setTickerIndex((current) => (current + 1) % liveDonations.length);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [liveDonations.length]);

  useEffect(() => {
    if (tickerIndex >= liveDonations.length) {
      setTickerIndex(0);
    }
  }, [liveDonations.length, tickerIndex]);

  return (
    <div className="relative overflow-hidden">
      <Head>
        <title>Stellar IndigoPay — Fund the planet. One XLM at a time.</title>
        <meta
          name="description"
          content="Stellar IndigoPay connects donors with verified climate projects worldwide. Donations go directly on-chain — no banks, no delays, no fees swallowed by middlemen."
        />
      </Head>
      {/* Background gradient */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-0 inset-x-0 h-[600px] bg-gradient-to-b from-[rgba(79,70,229,0.03)] via-[rgba(124,58,237,0.02)] to-transparent dark:from-[rgba(129,140,248,0.05)] dark:via-[rgba(139,92,246,0.03)]" />
        <div className="absolute top-1/4 -right-32 w-96 h-96 rounded-full bg-[rgba(79,70,229,0.04)] dark:bg-[rgba(129,140,248,0.06)] blur-3xl" />
        <div className="absolute top-1/3 -left-32 w-80 h-80 rounded-full bg-[rgba(245,158,11,0.03)] dark:bg-[rgba(251,191,36,0.04)] blur-3xl" />
      </div>

      <div className="max-w-6xl mx-auto px-4 sm:px-6 relative z-10">
        {/* ── Hero ────────────────────────────────────────────────────── */}
        <div className="text-center pt-20 pb-16 animate-fade-in relative">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-[rgba(99,102,241,0.15)] bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] text-[#4F46E5] dark:text-[#818CF8] text-xs font-semibold mb-8 font-body shadow-sm">
            <span className="w-1.5 h-1.5 rounded-full bg-[#4F46E5] dark:bg-[#818CF8] animate-pulse" />
            Open Source · Built on Stellar · Powered by Soroban
          </div>

          <h1 className="font-display text-5xl sm:text-6xl md:text-7xl font-bold text-[#0F172A] dark:text-[#E2E8F0] leading-tight mb-6 tracking-tight">
            Fund the planet.
            <br />
            <span className="text-gradient italic">One XLM at a time.</span>
          </h1>

          <p className="text-[#475569] dark:text-[#94A3B8] text-lg sm:text-xl max-w-2xl mx-auto mb-10 leading-relaxed font-body">
            Stellar-IndigoPay connects donors with verified climate projects
            worldwide. Donations go directly on-chain — no banks, no delays, no
            fees swallowed by middlemen.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            {publicKey ? (
              <>
                <Link
                  href="/projects"
                  className="btn-primary text-base px-8 py-3.5 gap-2"
                >
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                    />
                  </svg>
                  Browse Projects
                </Link>
                <Link
                  href="/dashboard"
                  className="btn-secondary text-base px-8 py-3.5"
                >
                  My Impact
                </Link>
              </>
            ) : (
              <>
                <button
                  onClick={() => setShowConnect(true)}
                  className="btn-primary text-base px-8 py-3.5 gap-2"
                >
                  <svg
                    className="w-5 h-5"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                    />
                  </svg>
                  Start Donating
                </button>
                <Link
                  href="/projects"
                  className="btn-secondary text-base px-8 py-3.5"
                >
                  Browse Projects
                </Link>
              </>
            )}
          </div>
        </div>

        {/* ── Stats ───────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] rounded-2xl overflow-hidden border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] mb-20 shadow-indigo">
          {buildHeroStats(globalStats).map((s) => (
            <StatItem key={s.label} stat={s} />
          ))}
        </div>

        {/* ── Global CO2 Offset Ticker ────────────────────────────── */}
        {globalStats !== null && <CO2OffsetTicker stats={globalStats} />}

        {/* ── Featured Project Spotlight ──────────────────────────── */}
        {featuredProject !== null && (
          <FeaturedProjectCard project={featuredProject} />
        )}

        {/* ── Features ────────────────────────────────────────────────── */}
        <div className="mb-20">
          <div className="text-center mb-12">
            <h2 className="font-display text-3xl sm:text-4xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-3">
              Why <span className="text-gradient">IndigoPay?</span>
            </h2>
            <p className="text-[#475569] dark:text-[#94A3B8] max-w-xl mx-auto font-body">
              Blockchain-powered climate finance that actually reaches the
              projects that need it.
            </p>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {FEATURES.map((f) => (
              <div
                key={f.title}
                className="card hover:shadow-indigo transition-all group"
              >
                <div className="w-12 h-12 rounded-xl bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-xl mb-4 group-hover:scale-110 transition-transform">
                  {f.icon}
                </div>
                <h3 className="font-display font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2 text-base">
                  {f.title}
                </h3>
                <p className="text-[#475569] dark:text-[#94A3B8] text-sm leading-relaxed font-body">
                  {f.desc}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Categories ──────────────────────────────────────────────── */}
        <div className="mb-20">
          <div className="text-center mb-10">
            <h2 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-3">
              Explore by <span className="text-gradient">Category</span>
            </h2>
            <p className="text-[#475569] dark:text-[#94A3B8] max-w-xl mx-auto font-body mb-8">
              Browse active climate projects across different impact areas
            </p>
          </div>

          {/* Category Stats Bar Chart */}
          {categoryStats.length > 0 && (
            <CategoryStatsChart stats={categoryStats} />
          )}

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-8">
            {CATEGORIES.map((cat) => (
              <Link
                key={cat.label}
                href={`/projects?category=${encodeURIComponent(cat.label)}`}
                className="card text-center hover:shadow-indigo hover:border-[rgba(99,102,241,0.25)] dark:hover:border-[rgba(129,140,248,0.30)] transition-all group py-5"
              >
                <div className="text-3xl mb-2 transition-transform group-hover:scale-110">
                  {cat.icon}
                </div>
                <p className="text-xs font-semibold text-[#475569] dark:text-[#94A3B8] group-hover:text-[#4F46E5] dark:group-hover:text-[#818CF8] transition-colors font-body">
                  {cat.label}
                </p>
              </Link>
            ))}
          </div>
        </div>

        {/* ── Badge system callout ─────────────────────────────────────── */}
        <div className="card card-gradient text-center py-12 mb-20">
          <h2 className="font-display text-3xl font-bold text-white mb-4">
            Earn Impact Badges 🌟
          </h2>
          <p className="text-white/80 max-w-xl mx-auto mb-8 font-body">
            As you donate more, you unlock on-chain badges recorded on the
            Stellar blockchain. Show your commitment to the planet.
          </p>
          <div className="flex flex-wrap justify-center gap-6">
            {[
              { emoji: "🌱", name: "Seedling", threshold: "10+ XLM" },
              { emoji: "🌳", name: "Tree", threshold: "100+ XLM" },
              { emoji: "🌲", name: "Forest", threshold: "500+ XLM" },
              { emoji: "🌍", name: "Earth Guardian", threshold: "2,000+ XLM" },
            ].map((b) => (
              <div
                key={b.name}
                className="bg-white/10 backdrop-blur-sm rounded-2xl p-5 border border-white/20 text-center min-w-[130px]"
              >
                <div className="text-4xl mb-2">{b.emoji}</div>
                <p className="font-display font-semibold text-white text-sm">
                  {b.name}
                </p>
                <p className="text-xs text-white/60 font-body mt-1">
                  {b.threshold}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Footer ──────────────────────────────────────────────────── */}
        <div className="text-center pb-12 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.08)] pt-8">
          <p className="text-[#64748B] dark:text-[#94A3B8] text-sm font-body">
            Open source · MIT License ·{" "}
            <a
              href="https://github.com/Stellar-IndigoPay/Stellar-IndigoPay"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium transition-colors"
            >
              Contribute on GitHub →
            </a>
          </p>
          <p className="text-[#64748B] dark:text-[#94A3B8] text-sm font-body mt-2">
            💬{" "}
            <a
              href="https://t.me/StellarIndigoPay"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium transition-colors"
            >
              Join our Telegram community →
            </a>
          </p>
        </div>
      </div>

      {/* Wallet connect modal (accessible: focus trap + Esc to close + aria-modal). */}
      {showConnect && !publicKey && (
        <ConnectWalletDialog
          onConnect={(pk) => {
            onConnect(pk);
            setShowConnect(false);
          }}
          onClose={() => setShowConnect(false)}
        />
      )}

      <LiveDonationTicker donations={liveDonations} activeIndex={tickerIndex} />
    </div>
  );
}

function LiveDonationTicker({
  donations,
  activeIndex,
}: {
  donations: LiveDonationTickerItem[];
  activeIndex: number;
}) {
  if (donations.length === 0) return null;
  const item = donations[activeIndex];

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-[rgba(99,102,241,0.20)] dark:border-[rgba(129,140,248,0.20)] bg-[#0F172A]/95 dark:bg-[#0A0A1A]/95 backdrop-blur px-4 py-2.5"
      role="region"
      aria-label="Live donation ticker"
    >
      <div className="max-w-6xl mx-auto flex items-center gap-3 text-sm text-white font-body">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-[#818CF8] font-bold">
          <span
            className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-sm shadow-emerald-500/50"
            aria-hidden="true"
          />
          Live donations
        </span>
        {/* aria-live polite so screen readers announce ticker updates but
            don't interrupt the user's current utterance. */}
        <p key={item.id} className="animate-fade-in-up" aria-live="polite">
          <span className="sr-only">A new donation: </span>
          just donated <strong>{formatXLM(item.amountXLM)}</strong> to{" "}
          <Link
            href={`/projects/${item.projectId}`}
            className="text-[#A5B4FC] hover:text-[#818CF8] transition-colors focus:outline-none focus:ring-2 focus:ring-[#818CF8] rounded"
          >
            {item.projectName}
          </Link>
        </p>
      </div>
    </div>
  );
}

function CategoryStatsChart({ stats }: { stats: CategoryStats[] }) {
  const maxCount = Math.max(...stats.map((s) => s.count));

  return (
    <div className="card p-6 mb-6">
      <h3 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-4">
        Active Projects by Category
      </h3>
      <div className="space-y-3">
        {stats.map((stat) => {
          const percentage = maxCount > 0 ? (stat.count / maxCount) * 100 : 0;
          return (
            <Link
              key={stat.category}
              href={`/projects?category=${encodeURIComponent(stat.category)}`}
              className="block group"
            >
              <div className="flex items-center gap-3 mb-1">
                <span className="text-xl">
                  {getCategoryIcon(stat.category)}
                </span>
                <span className="font-body text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0] group-hover:text-[#4F46E5] dark:group-hover:text-[#818CF8] transition-colors flex-1">
                  {stat.category}
                </span>
                <span className="font-body text-sm font-bold text-[#4F46E5] dark:text-[#818CF8]">
                  {stat.count}
                </span>
              </div>
              <div className="h-2 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] rounded-full transition-all duration-500 ease-out group-hover:from-[#6366F1] group-hover:to-[#8B5CF6]"
                  style={{ width: `${percentage}%` }}
                />
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function FeaturedProjectCard({ project }: { project: ClimateProject }) {
  const pct = progressPercent(project.raisedXLM, project.goalXLM);
  return (
    <div className="mb-20">
      <div className="text-center mb-8">
        <h2 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
          ⭐ Featured Project
        </h2>
        <p className="text-[#475569] dark:text-[#94A3B8] font-body">
          The project making the biggest impact right now
        </p>
      </div>
      <div className="card border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.18)] shadow-indigo hover:shadow-indigo transition-all p-6 sm:p-8">
        <div className="flex flex-col md:flex-row gap-6">
          <div className="flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <span className="text-xs font-semibold bg-[rgba(245,158,11,0.10)] text-[#D97706] dark:text-[#FBBF24] px-3 py-1 rounded-full border border-[rgba(245,158,11,0.20)] font-body">
                🏆 Most Donors
              </span>
              <span className="text-xs text-[#475569] dark:text-[#94A3B8] bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] px-2.5 py-1 rounded-full border border-[rgba(99,102,241,0.10)] font-body">
                {project.category}
              </span>
            </div>
            <h3 className="font-display text-2xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
              {project.name}
            </h3>
            <p className="text-[#475569] dark:text-[#94A3B8] text-sm leading-relaxed font-body mb-4 line-clamp-3">
              {project.description}
            </p>
            <div className="flex flex-wrap gap-4 text-sm mb-5">
              <span className="flex items-center gap-1 text-[#4F46E5] dark:text-[#818CF8] font-body">
                👥 <strong>{project.donorCount.toLocaleString()}</strong> donors
              </span>
              <span className="flex items-center gap-1 text-[#4F46E5] dark:text-[#818CF8] font-body">
                ♻️ <strong>{formatCO2(project.co2OffsetKg)}</strong> offset
              </span>
              <span className="flex items-center gap-1 text-[#64748B] dark:text-[#94A3B8] font-body">
                📍 {project.location}
              </span>
            </div>
            {/* Progress bar */}
            <div className="mb-2">
              <div className="flex justify-between text-xs mb-1 font-body">
                <span className="font-semibold text-[#4F46E5] dark:text-[#818CF8]">
                  {formatXLM(project.raisedXLM)} raised
                </span>
                <span className="text-[#64748B] dark:text-[#94A3B8]">
                  {pct}% of {formatXLM(project.goalXLM)}
                </span>
              </div>
              <div className="progress-bar h-2.5">
                <div
                  className={
                    pct >= 100
                      ? "progress-fill progress-fill-complete"
                      : "progress-fill"
                  }
                  style={{ width: `${Math.min(pct, 100)}%` }}
                />
              </div>
            </div>
          </div>
          <div className="flex flex-col justify-center gap-3 md:w-48">
            <Link
              href={`/projects/${project.id}`}
              className="btn-primary text-base py-3 px-6 text-center"
            >
              Donate Now
            </Link>
            <Link
              href={`/projects/${project.id}`}
              className="btn-secondary text-sm py-2.5 px-4 text-center"
            >
              View Project →
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function CO2OffsetTicker({ stats }: { stats: GlobalStats }) {
  const { count, elementRef } = useCountUp(stats.totalCO2OffsetKg, 2500);
  return (
    <div ref={elementRef} className="card-gradient text-center py-10 mb-20">
      <p className="text-3xl mb-2">🍃</p>
      <div className="font-display text-5xl sm:text-6xl font-bold text-white mb-2">
        {formatCO2(count)}
      </div>
      <p className="text-[#A5B4FC] text-sm font-body uppercase tracking-widest font-bold opacity-90">
        Total CO₂ Offset Across All Donations
      </p>
      <p className="text-[#C7D2FE] text-xs font-body mt-2">
        {stats.totalDonations.toLocaleString()} donations ·{" "}
        {stats.totalDonors.toLocaleString()} donors ·{" "}
        {parseFloat(stats.totalXLMRaised).toLocaleString()} XLM raised
      </p>
    </div>
  );
}

function StatItem({ stat }: { stat: any }) {
  const { count, elementRef } = useCountUp(stat.value, stat.duration);
  return (
    <div
      ref={elementRef}
      className="bg-white dark:bg-[#14142D] text-center py-10 px-4"
    >
      <div className="font-display text-4xl font-bold text-gradient mb-1">
        {stat.prefix}
        {count.toLocaleString()}
        {stat.suffix}
      </div>
      <div className="text-[#475569] dark:text-[#94A3B8] text-sm font-body uppercase tracking-widest font-bold">
        {stat.label}
      </div>
    </div>
  );
}

/**
 * ConnectWalletDialog — inline accessible modal used on the landing page.
 * Mirrors the WAI-ARIA dialog pattern so the wallet connect flow satisfies
 * WCAG 2.4.3 (Focus Order) and 2.1.2 (No Keyboard Trap).
 */
function ConnectWalletDialog({
  onConnect,
  onClose,
}: {
  onConnect: (pk: string) => void;
  onClose: () => void;
}) {
  const containerRef = useFocusTrap<HTMLDivElement>({
    active: true,
    onEscape: onClose,
  });
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    cancelButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={containerRef} className="w-full max-w-sm">
        <div role="dialog" aria-modal="true" aria-labelledby="connect-wallet-title">
          <h2 id="connect-wallet-title" className="sr-only">
            Connect your Stellar wallet
          </h2>
          <WalletConnect onConnect={onConnect} />
        </div>
        <button
          ref={cancelButtonRef}
          onClick={onClose}
          className="mt-4 w-full text-center text-sm text-[#475569] dark:text-[#94A3B8] hover:text-[#4F46E5] dark:hover:text-[#818CF8] transition-colors font-body focus:outline-none focus:ring-2 focus:ring-[rgba(99,102,241,0.30)] rounded"
          aria-label="Cancel wallet connection"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
