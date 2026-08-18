/**
 * pages/transparency.tsx — Public Transparency Dashboard
 *
 * A comprehensive real-time dashboard displaying:
 *   - Platform health status (public)
 *   - Impact overview with animated stat cards (public)
 *   - Live donation geo-map with real-time markers (public)
 *   - SLO error budget gauges (admin only)
 *   - Recent donations feed (public)
 *
 * Data sources:
 *   - GET /api/stats/global — polled every 30s
 *   - GET /api/readyz — polled every 30s for platform health
 *   - GET /api/admin/metrics/slo — polled every 60s (admin only)
 *   - Socket.IO — real-time donation events
 *   - GET /api/projects — project list with coordinates
 *
 * @see docs/issue-253.md for full spec.
 */
import { useMemo, useEffect, useState, useRef } from "react";
import dynamic from "next/dynamic";
import type { GetServerSideProps } from "next";
import PageMeta from "@/components/PageMeta";
import HealthBanner from "@/components/HealthBanner";
import StatCard, { StatCardSkeleton } from "@/components/StatCard";
import type { DonationMapItem } from "@/components/WorldMap";
import SLOStatusPanel from "@/components/SLOStatusPanel";
import { useGlobalStats, useSLOData } from "@/lib/transparencyHooks";
import { useWallet } from "@/lib/WalletProvider";
import { fetchProjects } from "@/lib/api";
import { streamGlobalProjectDonations } from "@/lib/stellar";
import { formatCO2, timeAgo } from "@/utils/format";
import type { ClimateProject } from "@/utils/types";

const WorldMap = dynamic(() => import("@/components/WorldMap"), {
  ssr: false,
  loading: () => (
    <div className="flex items-center justify-center h-64">
      <span className="text-sm text-[#94A3B8] font-body">Loading map…</span>
    </div>
  ),
});

// ── Icons (inline SVGs for zero dependencies) ────────────────────────────

function CoinIcon() {
  return (
    <svg
      className="w-5 h-5 text-[#4F46E5] dark:text-[#818CF8]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 6v6l4 2" />
    </svg>
  );
}

function LeafIcon() {
  return (
    <svg
      className="w-5 h-5 text-emerald-600 dark:text-emerald-400"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13 10V3L4 14h7v7l9-11h-7z"
      />
    </svg>
  );
}

function GlobeIcon() {
  return (
    <svg
      className="w-5 h-5 text-[#4F46E5] dark:text-[#818CF8]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="10" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z" />
    </svg>
  );
}

function UsersIcon() {
  return (
    <svg
      className="w-5 h-5 text-[#4F46E5] dark:text-[#818CF8]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function TrendingUpIcon() {
  return (
    <svg
      className="w-5 h-5 text-[#4F46E5] dark:text-[#818CF8]"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18" />
      <polyline points="17 6 23 6 23 12" />
    </svg>
  );
}

// ── Types ─────────────────────────────────────────────────────────────────

interface LiveDonationTickerItem {
  id: string;
  projectId: string;
  projectName: string;
  amountXLM: string;
  createdAt: string;
  lat?: number;
  lng?: number;
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function TransparencyDashboard() {
  const { publicKey, isConnected } = useWallet();

  // Data hooks
  const { stats, isLoading: statsLoading, error: statsError } = useGlobalStats(30000);
  const { sloData, isLoading: sloLoading, error: sloError } = useSLOData(60000);

  // Live donations via Horizon SSE
  const [liveDonations, setLiveDonations] = useState<LiveDonationTickerItem[]>([]);
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [donationMapItems, setDonationMapItems] = useState<DonationMapItem[]>([]);
  const closeStreamRef = useRef<(() => void) | null>(null);

  // Fetch project list on mount to seed the map and SSE stream
  useEffect(() => {
    let cancelled = false;

    fetchProjects({ limit: 100 })
      .then((fetchedProjects) => {
        if (cancelled) return;
        setProjects(fetchedProjects);

        // Start SSE stream for live donations
        if (fetchedProjects.length > 0) {
          const projectMap = fetchedProjects.map((p) => ({
            id: p.id,
            name: p.name,
            walletAddress: p.walletAddress,
          }));

          closeStreamRef.current = streamGlobalProjectDonations(
            projectMap,
            (donation) => {
              const mapItem: LiveDonationTickerItem = {
                id: donation.id,
                projectId: donation.projectId,
                projectName: donation.projectName,
                amountXLM: donation.amountXLM,
                createdAt: donation.createdAt,
              };

              setLiveDonations((prev) =>
                [mapItem, ...prev.filter((item) => item.id !== donation.id)].slice(0, 50),
              );

              // Also add to map items (deduplicated)
              setDonationMapItems((prev) => {
                if (prev.some((item) => item.id === donation.id)) return prev;
                return [
                  {
                    id: donation.id,
                    projectId: donation.projectId,
                    projectName: donation.projectName,
                    amountXLM: donation.amountXLM,
                    createdAt: donation.createdAt,
                  },
                  ...prev,
                ].slice(0, 10); // Keep last 10 for map markers
              });
            },
          );
        }
      })
      .catch(() => null);

    return () => {
      cancelled = true;
      if (closeStreamRef.current) closeStreamRef.current();
    };
  }, []);

  // Build project coordinates map for map markers
  const projectCoordinates = useMemo(() => {
    const coords: Record<string, { lat: number; lng: number }> = {};
    // Hardcoded approximate coordinates for demo projects
    // In production these would come from the backend geocoding service
    const geoHints: Record<string, { lat: number; lng: number }> = {
      "North America": { lat: 45, lng: -100 },
      "South America": { lat: -15, lng: -60 },
      Europe: { lat: 50, lng: 10 },
      Africa: { lat: 0, lng: 20 },
      Asia: { lat: 35, lng: 100 },
      Australia: { lat: -25, lng: 135 },
      "Southeast Asia": { lat: 10, lng: 105 },
    };

    projects.forEach((p) => {
      if (p.location) {
        const loc = p.location.toLowerCase();
        if (loc.includes("north america") || loc.includes("united states") || loc.includes("canada"))
          coords[p.id] = geoHints["North America"];
        else if (loc.includes("south america") || loc.includes("brazil"))
          coords[p.id] = geoHints["South America"];
        else if (loc.includes("europe") || loc.includes("germany") || loc.includes("france"))
          coords[p.id] = geoHints.Europe;
        else if (loc.includes("africa") || loc.includes("kenya") || loc.includes("nigeria"))
          coords[p.id] = geoHints.Africa;
        else if (loc.includes("asia") || loc.includes("india") || loc.includes("china"))
          coords[p.id] = geoHints.Asia;
        else if (loc.includes("australia"))
          coords[p.id] = geoHints.Australia;
        else if (loc.includes("southeast") || loc.includes("indonesia"))
          coords[p.id] = geoHints["Southeast Asia"];
        else
          coords[p.id] = { lat: 20, lng: 0 }; // Default center
      }
    });

    return coords;
  }, [projects]);

  // Determine if admins should see SLO section (publicKey present = authenticated)
  const canViewSLO = !!publicKey;

  const appUrl =
    process.env.NEXT_PUBLIC_APP_URL || "https://stellar-indigopay.app";
  const canonicalUrl = `${appUrl}/transparency`;

  return (
    <div className="min-h-screen bg-gradient-to-b from-white via-[rgba(99,102,241,0.02)] to-white dark:from-[#0A0A1A] dark:via-[rgba(129,140,248,0.02)] dark:to-[#0A0A1A]">
      <PageMeta
        title="Transparency Dashboard — Stellar IndigoPay"
        description="Real-time platform health, impact metrics, and live donation activity on Stellar IndigoPay."
        canonicalUrl={canonicalUrl}
      />

      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        {/* Page header */}
        <div className="mb-8">
          <h1 className="font-display text-3xl sm:text-4xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
            Transparency Dashboard
          </h1>
          <p className="text-[#475569] dark:text-[#94A3B8] font-body text-sm sm:text-base">
            Real-time platform health, impact metrics, and live donation
            activity — all verifiable on the Stellar blockchain.
          </p>
        </div>

        {/* Platform Health Banner */}
        <HealthBanner />

        {/* Impact Overview — 4 stat cards */}
        <section className="mb-8" aria-labelledby="impact-heading">
          <h2
            id="impact-heading"
            className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-5"
          >
            🌍 Impact Overview
          </h2>

          {statsLoading ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
              <StatCardSkeleton />
            </div>
          ) : statsError ? (
            <div className="card p-6 border border-red-200 dark:border-red-800/30 bg-red-50/50 dark:bg-red-950/20 text-center">
              <p className="text-sm text-red-600 dark:text-red-400 font-body">
                Unable to load impact stats. Please try again later.
              </p>
            </div>
          ) : stats ? (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              <StatCard
                label="Total Donated"
                value={parseFloat(stats.totalXLMRaised)}
                suffix="XLM"
                icon={<CoinIcon />}
                ariaLabel="Total XLM donated"
              />
              <StatCard
                label="CO₂ Offset"
                value={stats.totalCO2OffsetKg}
                suffix="kg"
                icon={<LeafIcon />}
                formatter={(val) => formatCO2(Math.round(val))}
                ariaLabel="Total CO2 offset in kilograms"
              />
              <StatCard
                label="Active Projects"
                value={stats.totalProjects}
                icon={<GlobeIcon />}
                ariaLabel="Total active projects"
              />
              <StatCard
                label="Unique Donors"
                value={stats.totalDonors}
                icon={<UsersIcon />}
                ariaLabel="Total unique donors"
              />
            </div>
          ) : null}
        </section>

        {/* Live Donation Map */}
        <section className="mb-8" aria-labelledby="map-heading">
          <h2
            id="map-heading"
            className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-5"
          >
            🗺️ Live Donation Activity
          </h2>
          <div className="card p-4 sm:p-6 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
            <WorldMap
              projects={projects}
              donations={donationMapItems}
              projectCoordinates={projectCoordinates}
            />
          </div>
        </section>

        {/* SLO Status — admin only */}
        {canViewSLO && (
          <section className="mb-8" aria-labelledby="slo-heading">
            <h2
              id="slo-heading"
              className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-5"
            >
              📊 Service Level Objectives
            </h2>
            <SLOStatusPanel
              sloData={sloData}
              isLoading={sloLoading}
              error={sloError}
            />
          </section>
        )}

        {/* Recent Donations Feed */}
        <section className="mb-8" aria-labelledby="feed-heading">
          <h2
            id="feed-heading"
            className="font-display text-xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-5"
          >
            📋 Recent Donations
          </h2>
          <div className="card p-4 sm:p-6 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
            <RecentDonationsFeed donations={liveDonations} />
          </div>
        </section>
      </div>

      {/* Inline style for extra animations */}
      <style jsx>{`
        .card {
          transition: box-shadow 0.2s ease;
        }
      `}</style>
    </div>
  );
}

// ── RecentDonationsFeed — inline component for the transparency page ─────

function RecentDonationsFeed({
  donations,
}: {
  donations: LiveDonationTickerItem[];
}) {
  const [newIds, setNewIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (donations.length === 0) return;
    const latestId = donations[0]?.id;
    if (latestId) {
      setNewIds((prev) => new Set(prev).add(latestId));
      const timer = setTimeout(() => {
        setNewIds((prev) => {
          const next = new Set(prev);
          next.delete(latestId);
          return next;
        });
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [donations]);

  if (donations.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-[#94A3B8] dark:text-[#64748B] text-sm font-body">
          Waiting for donations to appear…
        </p>
        <div className="flex items-center justify-center gap-1.5 mt-3">
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce" style={{ animationDelay: "0ms" }} />
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce" style={{ animationDelay: "150ms" }} />
          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce" style={{ animationDelay: "300ms" }} />
        </div>
      </div>
    );
  }

  return (
    <div className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.08)]">
      <div
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {donations.length > 0
          ? `Showing ${donations.length} recent donations. Most recent: ${donations[0].amountXLM} XLM to ${donations[0].projectName}.`
          : ""}
      </div>
      {donations.slice(0, 50).map((donation) => (
        <div
          key={donation.id}
          className={`flex items-center gap-3 py-3 px-2 rounded-lg transition-all duration-500 ${
            newIds.has(donation.id)
              ? "bg-emerald-50 dark:bg-emerald-950/20 -mx-2 px-4"
              : "hover:bg-[rgba(99,102,241,0.03)] dark:hover:bg-[rgba(129,140,248,0.05)]"
          }`}
        >
          {/* Amount */}
          <div className="flex-shrink-0 w-20 text-right">
            <span className="font-mono font-bold text-sm text-[#4F46E5] dark:text-[#818CF8]">
              +{parseFloat(donation.amountXLM).toFixed(2)}
            </span>
            <span className="text-[10px] text-[#64748B] dark:text-[#94A3B8] ml-0.5 font-body">
              XLM
            </span>
          </div>

          {/* Project name */}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0] truncate font-body">
              {donation.projectName}
            </p>
          </div>

          {/* Timestamp */}
          <span className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body flex-shrink-0">
            {timeAgo(donation.createdAt)}
          </span>

          {/* New badge */}
          {newIds.has(donation.id) && (
            <span className="text-[10px] font-semibold bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 px-1.5 py-0.5 rounded-full font-body flex-shrink-0">
              NEW
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

// Forces per-request SSR so middleware.ts can apply the CSP nonce.
export const getServerSideProps: GetServerSideProps = async () => {
  return { props: {} };
};
