/**
 * pages/dashboard.tsx — Donor impact dashboard
 */
import { useState, useEffect } from "react";
import type { GetServerSideProps } from "next";
import Link from "next/link";
import WalletConnect from "@/components/WalletConnect";
import EditProfileForm from "@/components/EditProfileForm";
import ProjectCard from "@/components/ProjectCard";
import ImpactCertificate from "@/components/ImpactCertificate";
import ProjectRating from "@/components/ProjectRating";
import Tabs from "@/components/Tabs";
import { fetchProfile, fetchDonorHistory, fetchProjects } from "@/lib/api";
import { getDueMonthlySubscriptions } from "@/lib/monthlyGiving";
import { getXLMBalance, getFriendBotFunding, NETWORK } from "@/lib/stellar";
import {
  formatXLM,
  formatCO2,
  timeAgo,
  shortenAddress,
  badgeEmoji,
  badgeLabel,
  calculateStreak,
} from "@/utils/format";
import { explorerUrl } from "@/lib/stellar";
import type {
  DonorProfile,
  Donation,
  ClimateProject,
  MonthlySubscription,
} from "@/utils/types";
import { useWishlist } from "@/hooks/useWishlist";
import DashboardSkeleton from "@/components/DashboardSkeleton";
import { QueryErrorFallback } from "@/components/QueryErrorFallback";
import { classifyError } from "@/lib/queryErrors";

export default function Dashboard() {
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<DonorProfile | null>(null);
  const [donations, setDonations] = useState<Donation[]>([]);
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savedProjects, setSavedProjects] = useState<ClimateProject[]>([]);
  const [allProjects, setAllProjects] = useState<ClimateProject[]>([]);
  const [isUnfunded, setIsUnfunded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [friendbotState, setFriendbotState] = useState<
    "idle" | "loading" | "success" | "error"
  >("idle");
  const [friendbotError, setFrienbotError] = useState<string | null>(null);
  const [dueSubscriptions, setDueSubscriptions] = useState<
    MonthlySubscription[]
  >([]);
  const { wishlist } = useWishlist();
  const [showCertificate, setShowCertificate] = useState(false);
  const [pendingRating, setPendingRating] = useState<{
    id: string;
    name: string;
  } | null>(null);

  useEffect(() => {
    if (!publicKey) return;
    setLoadError(null);
    Promise.all([
      fetchProfile(publicKey).catch(() => null),
      fetchDonorHistory(publicKey),
      getXLMBalance(publicKey).catch(() => {
        setIsUnfunded(true);
        return null;
      }),
      fetchProjects(),
    ])
      .then(([p, d, b, allProjects]) => {
        setProfile(p);
        setDonations(d);
        if (b !== null) {
          setBalance(b);
          setIsUnfunded(false);
        }
        setAllProjects(allProjects);
        setSavedProjects(
          allProjects.filter((proj) => wishlist.includes(proj.id)),
        );

        // Fetch pending rating
        return fetch(
          `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/ratings/pending?donorAddress=${publicKey}`,
        );
      })
      .then((r) => r?.json())
      .then((res) => {
        if (res?.success && res.data) {
          setPendingRating(res.data);
        }
      })
      // The pending-rating banner is non-essential: a failure here must not
      // collapse the whole dashboard into the error fallback.
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [publicKey, wishlist]);

  const handleRetryLoad = () => {
    if (isRetrying) return;
    setRetryCount((c) => c + 1);
    setIsRetrying(true);
    setLoadError(null);
    setLoading(true);
    Promise.all([
      fetchProfile(publicKey as string).catch(() => null),
      fetchDonorHistory(publicKey as string),
      getXLMBalance(publicKey as string).catch(() => {
        setIsUnfunded(true);
        return null;
      }),
      fetchProjects(),
    ])
      .then(([p, d, b, allProjects]) => {
        setProfile(p);
        setDonations(d);
        if (b !== null) {
          setBalance(b);
          setIsUnfunded(false);
        }
        setAllProjects(allProjects);
        setSavedProjects(
          allProjects.filter((proj) => wishlist.includes(proj.id)),
        );
        return fetch(
          `${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/ratings/pending?donorAddress=${publicKey}`,
        );
      })
      .then((r) => r?.json())
      .then((res) => {
        if (res?.success && res.data) {
          setPendingRating(res.data);
        }
      })
      // The pending-rating banner is non-essential (see initial load above).
      .catch(() => {})
      .finally(() => {
        setLoading(false);
        setIsRetrying(false);
      });
  };

  useEffect(() => {
    if (!publicKey) return;
    setDueSubscriptions(getDueMonthlySubscriptions());
  }, [publicKey]);

  const streak = calculateStreak(donations);

  const handleFriendbot = async () => {
    if (!publicKey) return;
    setFriendbotState("loading");
    setFrienbotError(null);
    try {
      const newBalance = await getFriendBotFunding(publicKey);
      setBalance(newBalance);
      setIsUnfunded(false);
      setFriendbotState("success");
    } catch (err: unknown) {
      setFrienbotError((err as Error).message || "Funding failed. Try again.");
      setFriendbotState("error");
    }
  };

  // Persistence for longest streak
  useEffect(() => {
    if (streak.longest > 0) {
      const stored = localStorage.getItem("longest_streak");
      if (!stored || parseInt(stored) < streak.longest) {
        localStorage.setItem("longest_streak", streak.longest.toString());
      }
    }
  }, [streak.longest]);

  if (!publicKey)
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-16">
        <div className="text-center mb-10">
          <h1 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-3">
            My Impact
          </h1>
          <p className="text-[#475569] dark:text-[#94A3B8] font-body">
            Connect your wallet to see your donation history and impact
          </p>
        </div>
        <WalletConnect onConnect={setPublicKey} />
      </div>
    );

  const totalDonated = profile?.totalDonatedXLM || "0";
  const co2Estimate = Math.round(parseFloat(totalDonated) * 12); // rough estimate
  const projectsCount = profile?.projectsSupported || 0;

  const topBadgeTier = profile?.badges?.length ? profile.badges[0].tier : null;
  const supportedProjects = Array.from(
    new Map(donations.map((d) => [d.projectId, d.projectId])).values(),
  )
    .slice(0, 50)
    .map((projectId) => {
      const p = allProjects.find((sp) => sp.id === projectId);
      return p
        ? { id: p.id, name: p.name }
        : { id: projectId, name: projectId };
    });

  const handlePrintCertificate = () => {
    const el = document.getElementById("impact-certificate");
    if (!el) return;
    const w = window.open(
      "",
      "_blank",
      "noopener,noreferrer,width=900,height=700",
    );
    if (!w) return;
    w.document.open();
    w.document.write(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Impact Certificate</title>
          <link rel="preconnect" href="https://fonts.googleapis.com">
          <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&family=Plus+Jakarta+Sans:wght@400;600;700&display=swap" rel="stylesheet">
          <style>
            * { box-sizing: border-box; }
            body { margin: 0; padding: 24px; font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; background: #FAFAFE; }
            @media print { body { background: #fff; padding: 0; } }
            .font-display { font-family: "Plus Jakarta Sans", system-ui, sans-serif; }
          </style>
        </head>
        <body>
          <div class="font-display"></div>
          ${el.outerHTML}
          <script>
            window.onload = () => { window.focus(); window.print(); };
          </script>
        </body>
      </html>
    `);
    w.document.close();
  };

  if (loading)
    return (
      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
        <DashboardSkeleton />
      </div>
    );

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-fade-in">
      {(loadError && !loading) || isRetrying ? (
        <QueryErrorFallback
          error={loadError}
          onRetry={handleRetryLoad}
          isRetrying={isRetrying}
          retryCount={retryCount}
          title="Couldn't load your dashboard"
        />
      ) : (
        <div className="contents">
          {pendingRating && publicKey && (
            <ProjectRating
              projectId={pendingRating.id}
              projectName={pendingRating.name}
              donorAddress={publicKey}
              onSuccess={() => setPendingRating(null)}
              onCancel={() => setPendingRating(null)}
            />
          )}

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
            <div>
              <h1 className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-1">
                My Impact
              </h1>
              <div className="flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="address-tag" data-testid="wallet-address">
                  {shortenAddress(publicKey)}
                </span>
              </div>
            </div>
            <Link
              href="/projects"
              className="btn-primary text-sm py-2.5 px-5 flex-shrink-0 gap-2"
            >
              <svg
                className="w-4 h-4"
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
              Donate Now
            </Link>
          </div>

          {dueSubscriptions.length > 0 && (
            <div className="card mb-6 border-[rgba(245,158,11,0.25)] bg-[rgba(245,158,11,0.06)]">
              <h2 className="font-display text-lg font-semibold text-[#B45309] mb-2">
                Monthly Giving Due Today
              </h2>
              <div className="space-y-2">
                {dueSubscriptions.map((subscription) => (
                  <div
                    key={subscription.id}
                    className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2"
                  >
                    <p className="text-sm text-amber-900 font-body">
                      {subscription.projectName}:{" "}
                      {formatXLM(subscription.amountXLM)}
                    </p>
                    <Link
                      href={`/projects/${subscription.projectId}?amount=${encodeURIComponent(subscription.amountXLM)}&monthlySubId=${encodeURIComponent(subscription.id)}`}
                      className="btn-primary text-xs py-1.5 px-3 inline-flex items-center justify-center"
                    >
                      Pay Now
                    </Link>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Testnet Friendbot funding card */}
          {NETWORK === "testnet" && isUnfunded && (
            <div className="card mb-6 bg-[rgba(245,158,11,0.06)] border-[rgba(245,158,11,0.20)] shadow-sm">
              <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4">
                <div className="text-3xl">🚰</div>
                <div className="flex-1">
                  <h2 className="font-display font-bold text-[#B45309] text-base mb-1">
                    Your testnet wallet has no XLM
                  </h2>
                  <p className="text-amber-700 text-sm font-body">
                    Fund it instantly with Stellar Friendbot to start donating
                    on testnet.
                  </p>
                  {friendbotState === "success" && (
                    <p className="text-green-700 text-sm font-body mt-1 font-semibold">
                      ✓ Funded! Your wallet received 10,000 XLM testnet tokens.
                    </p>
                  )}
                  {friendbotState === "error" && friendbotError && (
                    <p className="text-red-600 text-sm font-body mt-1">
                      {friendbotError}
                    </p>
                  )}
                </div>
                <button
                  onClick={handleFriendbot}
                  disabled={
                    friendbotState === "loading" || friendbotState === "success"
                  }
                  className="btn-primary text-sm py-2.5 px-5 flex-shrink-0 disabled:opacity-60"
                >
                  {friendbotState === "loading"
                    ? "Funding…"
                    : friendbotState === "success"
                      ? "✓ Funded!"
                      : "💧 Fund My Testnet Wallet"}
                </button>
              </div>
            </div>
          )}

          {/* Stats grid */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
            {[
              {
                icon: "💚",
                label: "Total Donated",
                value: formatXLM(totalDonated),
              },
              {
                icon: "♻️",
                label: "Est. CO₂ Offset",
                value: formatCO2(co2Estimate),
              },
              {
                icon: "🌍",
                label: "Projects Supported",
                value: projectsCount.toString(),
              },
              {
                icon: "💰",
                label: "XLM Balance",
                value: balance ? formatXLM(balance) : "—",
              },
            ].map((stat) => (
              <div
                key={stat.label}
                className="card text-center shadow-sm border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
              >
                <p className="text-2xl mb-2">{stat.icon}</p>
                <p className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] text-lg leading-tight">
                  {stat.value}
                </p>
                <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-1 font-body uppercase tracking-wider font-bold opacity-60">
                  {stat.label}
                </p>
              </div>
            ))}
          </div>

          <Tabs
            ariaLabel="Dashboard sections"
            defaultValue="impact"
            tabs={[
              {
                id: "impact",
                label: "My Impact",
                content: (
                  <div className="space-y-8 animate-slide-up focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0A0A1A]">
                    {/* Certificate */}
                    <div className="card">
                      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                        <div>
                          <h2 className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0]">
                            Your Impact Certificate
                          </h2>
                          <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body mt-1">
                            Download a PDF-ready certificate or share it on
                            social media.
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            onClick={() => setShowCertificate((v) => !v)}
                            className="btn-primary text-sm py-2.5 px-5"
                          >
                            {showCertificate ? "Hide" : "Preview"}
                          </button>
                          <button
                            onClick={handlePrintCertificate}
                            className="px-5 py-2.5 rounded-xl text-sm font-semibold border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] hover:bg-[rgba(99,102,241,0.10)] dark:hover:bg-[rgba(129,140,248,0.12)] transition-all"
                          >
                            Download Certificate
                          </button>
                        </div>
                      </div>

                      {showCertificate && (
                        <div className="mt-6">
                          <ImpactCertificate
                            donorAddress={publicKey}
                            donorName={profile?.displayName || null}
                            totalDonatedXLM={totalDonated}
                            totalCO2OffsetKg={co2Estimate}
                            badgeTier={topBadgeTier}
                            projectsSupported={supportedProjects}
                          />
                        </div>
                      )}
                    </div>

                    {/* Streak Section */}
                    <div className="card-gradient text-white border-none">
                      <div className="flex flex-col md:flex-row items-center justify-between gap-6">
                        <div className="flex items-center gap-6">
                          <div className="w-20 h-20 bg-white/10 rounded-2xl flex items-center justify-center text-4xl border border-white/20 shadow-inner">
                            {streak.current > 0 ? "🔥" : "🌱"}
                          </div>
                          <div>
                            <h2 className="text-2xl font-display font-bold">
                              {streak.current} Month Streak
                            </h2>
                            <p className="text-[#C7D2FE] text-sm font-body">
                              {streak.current > 0
                                ? "Keep it up! Your monthly support drives long-term change."
                                : "Start a monthly donation habit to build your streak!"}
                            </p>
                          </div>
                        </div>
                        <div className="flex gap-3">
                          {[
                            { m: 3, label: "3mo", emoji: "🥉" },
                            { m: 6, label: "6mo", emoji: "🥈" },
                            { m: 12, label: "12mo", emoji: "🥇" },
                          ].map((m) => (
                            <div
                              key={m.m}
                              className={`flex flex-col items-center p-3 rounded-xl border transition-all ${streak.longest >= m.m ? "bg-white/10 border-white/30" : "bg-black/20 border-white/5 opacity-30"}`}
                              title={`${m.m} Month Milestone`}
                            >
                              <span className="text-xl mb-1">{m.emoji}</span>
                              <span className="text-[10px] font-bold uppercase tracking-widest">
                                {m.label}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                      {streak.current === 0 && donations.length > 0 && (
                        <div className="mt-4 pt-4 border-t border-white/20 text-center">
                          <p className="text-xs text-[#A5B4FC] font-body italic">
                            Streak broken? Don&apos;t worry, every donation
                            counts. Start fresh this month!
                          </p>
                        </div>
                      )}
                    </div>

                    {/* Profile Edit */}
                    <EditProfileForm publicKey={publicKey} />

                    {/* Badges */}
                    {profile?.badges && profile.badges.length > 0 && (
                      <div className="card shadow-sm border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
                        <h2 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-4 flex items-center gap-2">
                          <span>🏆</span> Your Impact Badges
                        </h2>
                        <div className="flex flex-wrap gap-4">
                          {profile.badges.map((badge, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-3 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] rounded-xl px-4 py-3 border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-colors"
                            >
                              <span className="text-3xl">
                                {badgeEmoji(badge.tier)}
                              </span>
                              <div>
                                <p className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] text-sm font-body">
                                  {badgeLabel(badge.tier)}
                                </p>
                                <p className="text-[10px] text-[#64748B] dark:text-[#94A3B8] font-body uppercase tracking-widest font-bold opacity-80">
                                  Earned {timeAgo(badge.earnedAt)}
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Donation history */}
                    <div
                      className="card shadow-sm border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
                      data-testid="donation-history"
                    >
                      <h2 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-5 flex items-center gap-2">
                        <span>📜</span> Donation History
                      </h2>
                      {donations.length === 0 ? (
                        <div className="text-center py-12">
                          <p className="text-4xl mb-3">🌱</p>
                          <p className="text-[#475569] dark:text-[#94A3B8] mb-4 font-body">
                            No donations yet
                          </p>
                          <Link
                            href="/projects"
                            className="btn-primary text-sm"
                          >
                            Browse Projects →
                          </Link>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {donations.map((d) => (
                            <div
                              key={d.id}
                              className="flex items-center gap-4 p-4 rounded-xl bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-colors border border-transparent hover:border-[rgba(99,102,241,0.10)] dark:hover:border-[rgba(129,140,248,0.12)]"
                            >
                              <div className="w-10 h-10 rounded-full bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] flex items-center justify-center text-lg flex-shrink-0">
                                🌱
                              </div>
                              <div className="flex-1 min-w-0">
                                <p className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] font-body">
                                  Project donation
                                </p>
                                {d.message && (
                                  <p className="text-xs text-[#475569] dark:text-[#94A3B8] italic font-body truncate">
                                    &quot;{d.message}&quot;
                                  </p>
                                )}
                                <p className="text-[10px] text-[#64748B] dark:text-[#94A3B8] font-body uppercase tracking-wider font-bold opacity-70">
                                  {timeAgo(d.createdAt)}
                                </p>
                              </div>
                              <div className="text-right flex-shrink-0">
                                <p className="font-mono font-semibold text-[#4F46E5] dark:text-[#818CF8] text-sm">
                                  {d.currency === "USDC"
                                    ? `$${parseFloat(d.amount || "0").toFixed(2)} USDC`
                                    : formatXLM(d.amountXLM || "0")}
                                </p>
                                <a
                                  href={explorerUrl(d.transactionHash)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-[10px] text-[#4F46E5] dark:text-[#818CF8] hover:text-[#6366F1] dark:hover:text-[#A5B4FC] font-bold uppercase tracking-widest transition-colors"
                                >
                                  View tx ↗
                                </a>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              },
              {
                id: "saved",
                label: (
                  <>
                    Saved Projects
                    {wishlist.length > 0 && (
                      <span
                        aria-label={`${wishlist.length} saved`}
                        className="bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8] px-2 py-0.5 rounded-full text-[10px]"
                      >
                        {wishlist.length}
                      </span>
                    )}
                  </>
                ),
                content: (
                  <div className="animate-slide-up focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0A0A1A]">
                    {savedProjects.length === 0 ? (
                      <div className="card text-center py-20">
                        <p className="text-5xl mb-4">❤️</p>
                        <h2 className="text-xl font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
                          No saved projects yet
                        </h2>
                        <p className="text-[#475569] dark:text-[#94A3B8] mb-8 font-body">
                          Save projects you&apos;re interested in to track their
                          progress.
                        </p>
                        <Link href="/projects" className="btn-primary text-sm">
                          Explore Projects
                        </Link>
                      </div>
                    ) : (
                      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-6">
                        {savedProjects.map((project) => (
                          <ProjectCard key={project.id} project={project} />
                        ))}
                      </div>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </div>
      )}
    </div>
  );
}

// Forces per-request SSR so the CSP nonce set in middleware.ts reaches
// _document.tsx — see the matching comment in pages/index.tsx.
export const getServerSideProps: GetServerSideProps = async () => {
  return { props: {} };
};
