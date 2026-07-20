/**
 * components/GovernanceSkeleton.tsx
 *
 * Loading placeholder that mirrors the governance page:
 *   - page header + intro
 *   - wallet / badge status card
 *   - quorum notice + weight legend
 *   - proposal cards (title, meta, progress bar, vote buttons)
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import { SkeletonBox, SkeletonProgressBar } from "@/components/Skeleton";
import PageMeta from "@/components/PageMeta";

export default function GovernanceSkeleton() {
  return (
    <div className="min-h-screen bg-[#fcfdfc] font-body text-forest-900 pb-20">
      <PageMeta
        title="Governance | Stellar IndigoPay"
        description="Vote on project verification proposals with your impact badge."
        canonicalUrl="https://stellar-indigopay.app/governance"
      />
      <main className="max-w-3xl mx-auto px-4 py-12 sm:px-6">
        {/* Header */}
        <div className="mb-10">
          <SkeletonBox className="h-10 rounded w-72 mb-3" palette="indigo" />
          <SkeletonBox className="h-4 rounded w-2/3" palette="indigo" />
        </div>

        {/* Wallet / badge status card */}
        <div className="card mb-8 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-4">
            <SkeletonBox className="h-4 rounded w-40" palette="indigo" />
            <SkeletonBox className="h-8 rounded-full w-28" palette="indigo" />
          </div>
        </div>

        {/* Quorum notice */}
        <div className="mb-6 rounded-xl bg-[rgba(245,158,11,0.06)] border border-[rgba(245,158,11,0.20)] px-4 py-3">
          <SkeletonBox className="h-4 rounded w-full" palette="indigo" />
        </div>

        {/* Weight legend */}
        <div className="mb-6 flex flex-wrap gap-3">
          {[1, 2, 3, 4].map((i) => (
            <SkeletonBox key={i} className="h-4 rounded w-28" palette="indigo" />
          ))}
        </div>

        {/* Proposal cards */}
        <div className="space-y-4 py-4">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="card rounded-2xl p-5 animate-pulse pointer-events-none"
            >
              <div className="flex items-start justify-between gap-4 mb-4">
                <div className="flex-1 space-y-2">
                  <SkeletonBox className="h-5 rounded w-2/3" palette="indigo" />
                  <SkeletonBox className="h-3 rounded w-1/3" palette="indigo" />
                </div>
                <SkeletonBox className="h-6 rounded-full w-16" palette="indigo" />
              </div>
              <SkeletonProgressBar className="mb-4" palette="indigo" />
              <div className="flex gap-2">
                <SkeletonBox className="h-10 rounded-xl flex-1" palette="indigo" />
                <SkeletonBox className="h-10 rounded-xl flex-1" palette="indigo" />
              </div>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
