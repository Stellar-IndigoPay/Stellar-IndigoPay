/**
 * components/LeaderboardSkeleton.tsx
 *
 * Loading placeholder that mirrors the leaderboard page:
 *   - page header + intro
 *   - badge tier legend
 *   - period tabs
 *   - the leaderboard table (delegates to LeaderboardTableSkeleton)
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import {
  SkeletonBox,
  SkeletonText,
  SkeletonBadge,
} from "@/components/Skeleton";
import { LeaderboardTableSkeleton } from "@/components/LeaderboardTable";

export default function LeaderboardSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 animate-pulse pointer-events-none">
      {/* Header */}
      <div className="text-center mb-10">
        <SkeletonBox className="h-12 w-12 rounded-full mx-auto mb-4" palette="indigo" />
        <SkeletonBox className="h-9 rounded w-64 mx-auto mb-3" palette="indigo" />
        <SkeletonText
          lines={2}
          widths={["w-3/4", "w-1/2"]}
          className="max-w-xl mx-auto"
          palette="indigo"
        />
      </div>

      {/* Badge legend */}
      <div className="card mb-8 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
        <SkeletonBox className="h-5 rounded w-40 mx-auto mb-3" palette="indigo" />
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="bg-white dark:bg-[#14142D] rounded-xl p-3 border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
            >
              <SkeletonBox className="h-8 w-8 rounded-full mx-auto mb-1" palette="indigo" />
              <SkeletonBox className="h-3 rounded w-16 mx-auto mb-1" palette="indigo" />
              <SkeletonBox className="h-2 rounded w-12 mx-auto" palette="indigo" />
            </div>
          ))}
        </div>
      </div>

      {/* Period tabs */}
      <div className="mb-8 flex gap-2 justify-center">
        {[1, 2, 3].map((i) => (
          <SkeletonBadge key={i} className="w-24 h-9" palette="indigo" />
        ))}
      </div>

      {/* Table placeholder */}
      <LeaderboardTableSkeleton rows={8} />
    </div>
  );
}
