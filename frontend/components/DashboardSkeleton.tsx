/**
 * components/DashboardSkeleton.tsx
 *
 * Loading placeholder that mirrors the dashboard layout:
 *   - header ("My Impact" + wallet pill + Donate button)
 *   - stats grid (4 stat cards)
 *   - tabbed sections: impact certificate, streak, donation history
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import {
  SkeletonBox,
  SkeletonText,
  SkeletonStatCard,
  SkeletonAvatar,
  SkeletonBadge,
} from "@/components/Skeleton";

export default function DashboardSkeleton() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 animate-pulse pointer-events-none">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-8">
        <div>
          <SkeletonBox className="h-9 rounded w-44 mb-2" palette="indigo" />
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-forest-300" />
            <SkeletonBox className="h-3 rounded w-24" palette="indigo" />
          </div>
        </div>
        <SkeletonBox className="h-10 rounded-xl w-36" palette="indigo" />
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {[1, 2, 3, 4].map((i) => (
          <SkeletonStatCard key={i} palette="indigo" />
        ))}
      </div>

      {/* Tab strip */}
      <div className="flex gap-2 mb-8">
        {[1, 2].map((i) => (
          <SkeletonBox
            key={i}
            className="h-9 rounded-lg w-24"
            palette="indigo"
          />
        ))}
      </div>

      {/* Impact Certificate card */}
      <div className="card mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex-1">
            <SkeletonBox className="h-6 rounded w-56 mb-2" palette="indigo" />
            <SkeletonText lines={2} className="max-w-md" palette="indigo" />
          </div>
          <SkeletonBox className="h-10 rounded-xl w-28" palette="indigo" />
        </div>
      </div>

      {/* Streak card */}
      <div className="card-gradient text-white border-none mb-8">
        <div className="flex flex-col md:flex-row items-center justify-between gap-6">
          <div className="flex items-center gap-6">
            <SkeletonBox className="w-20 h-20 rounded-2xl bg-white/20" palette="indigo" />
            <div className="space-y-2">
              <SkeletonBox className="h-7 rounded w-40 bg-white/20" palette="indigo" />
              <SkeletonBox className="h-4 rounded w-64 bg-white/20" palette="indigo" />
            </div>
          </div>
          <div className="flex gap-3">
            {[1, 2, 3].map((i) => (
              <SkeletonBox
                key={i}
                className="h-16 w-16 rounded-xl bg-white/20"
                palette="indigo"
              />
            ))}
          </div>
        </div>
      </div>

      {/* Donation history card */}
      <div className="card">
        <SkeletonBox className="h-6 rounded w-40 mb-5" palette="indigo" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex items-center gap-4 p-4 rounded-xl bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)]"
            >
              <SkeletonAvatar size="sm" palette="indigo" />
              <div className="flex-1 space-y-2">
                <SkeletonBox className="h-3 rounded w-1/3" palette="indigo" />
                <SkeletonBox className="h-2 rounded w-1/4" palette="indigo" />
              </div>
              <SkeletonBadge className="w-20" palette="indigo" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
