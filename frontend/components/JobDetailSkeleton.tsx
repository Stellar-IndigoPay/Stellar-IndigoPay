/**
 * components/JobDetailSkeleton.tsx
 *
 * Loading placeholder that mirrors the job detail page:
 *   - breadcrumb nav
 *   - header card (title, description)
 *   - employer / freelancer / escrow / status grid
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import { SkeletonBox, SkeletonText } from "@/components/Skeleton";

export default function JobDetailSkeleton() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 animate-pulse pointer-events-none">
      {/* Breadcrumb */}
      <div className="mb-6 flex items-center gap-2">
        <SkeletonBox className="h-4 rounded w-10" palette="forest" />
        <span className="text-forest-300 mx-2">/</span>
        <SkeletonBox className="h-4 rounded w-32" palette="forest" />
      </div>

      <div className="card border border-forest-100/80 shadow-sm space-y-6">
        {/* Title + description */}
        <div className="space-y-3">
          <SkeletonBox className="h-8 rounded w-2/3" palette="forest" />
          <SkeletonText lines={3} palette="forest" />
        </div>

        {/* Detail grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="space-y-1">
              <SkeletonBox className="h-3 rounded w-16" palette="forest" />
              <SkeletonBox className="h-4 rounded w-32" palette="forest" />
            </div>
          ))}
        </div>

        {/* Wallet connect / action area */}
        <SkeletonBox className="h-12 rounded-xl w-full" palette="forest" />
      </div>
    </div>
  );
}
