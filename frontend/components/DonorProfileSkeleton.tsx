/**
 * components/DonorProfileSkeleton.tsx
 *
 * Loading placeholder that mirrors the donor profile page:
 *   - header card (avatar + name + address pill + share button)
 *   - stats row (Total Donated / Projects / Member Since)
 *   - earned badges card
 *   - claim NFT card
 *   - recent donations list
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import {
  SkeletonBox,
  SkeletonAvatar,
  SkeletonBadge,
} from "@/components/Skeleton";

export default function DonorProfileSkeleton() {
  return (
    <div className="min-h-screen bg-leaf">
      <div className="max-w-2xl mx-auto px-4 py-10 space-y-6 animate-pulse pointer-events-none">
        {/* Header card */}
        <div className="card shadow-green">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div className="flex items-center gap-4">
              <SkeletonAvatar size="lg" palette="forest" />
              <div className="space-y-2">
                <SkeletonBox
                  className="h-5 rounded w-40"
                  palette="forest"
                />
                <SkeletonBox
                  className="h-3 rounded w-28"
                  palette="forest"
                />
              </div>
            </div>
            <SkeletonBox className="h-9 rounded-xl w-24" palette="forest" />
          </div>
          <div className="mt-4 pt-4 border-t border-[rgba(34,114,57,0.08)]">
            <SkeletonBox className="h-4 rounded w-full" palette="forest" />
            <SkeletonBox
              className="h-4 rounded w-2/3 mt-2"
              palette="forest"
            />
          </div>
        </div>

        {/* Stats row */}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-20" />
          ))}
        </div>

        {/* Earned badges */}
        <div className="card">
          <SkeletonBox className="h-5 rounded w-32 mb-3" palette="forest" />
          <div className="flex flex-wrap gap-2">
            {[1, 2].map((i) => (
              <SkeletonBadge key={i} className="w-24 h-7" palette="forest" />
            ))}
          </div>
        </div>

        {/* Claim NFT card */}
        <div className="card">
          <SkeletonBox className="h-5 rounded w-40 mb-2" palette="forest" />
          <SkeletonBox className="h-3 rounded w-3/4 mb-4" palette="forest" />
          <SkeletonBox className="h-10 rounded-xl w-full" palette="forest" />
        </div>

        {/* Recent donations */}
        <div className="card">
          <SkeletonBox className="h-5 rounded w-36 mb-3" palette="forest" />
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center gap-4 p-4 rounded-xl bg-[rgba(34,114,57,0.04)] border border-transparent"
              >
                <SkeletonAvatar size="sm" palette="forest" />
                <div className="flex-1 space-y-2">
                  <SkeletonBox className="h-3 rounded w-1/3" palette="forest" />
                  <SkeletonBox className="h-2 rounded w-1/4" palette="forest" />
                </div>
                <SkeletonBox className="h-4 rounded w-16" palette="forest" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
