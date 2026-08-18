/**
 * components/ProjectDetailSkeleton.tsx
 *
 * Loading placeholder that mirrors the final project detail layout:
 *   - back link
 *   - hero header (category icon, badges, title, location, rating)
 *   - progress bar + stats cards
 *   - AI summary card, description card, milestones
 *   - updates / donation feed cards
 *   - sidebar (impact calculator + donate form)
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import {
  SkeletonBox,
  SkeletonAvatar,
  SkeletonText,
  SkeletonBadge,
  SkeletonList,
  SkeletonProgressBar,
} from "@/components/Skeleton";
import { ProjectProgressBarSkeleton } from "@/components/ProjectProgressBar";

export default function ProjectDetailSkeleton() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-10 pb-24 sm:pb-10 animate-pulse pointer-events-none">
      {/* Back link */}
      <SkeletonBox className="h-4 rounded w-28 mb-6" palette="forest" />

      {/* Hero header card */}
      <div className="card space-y-5">
        <div className="flex items-start gap-4 mb-1">
          <SkeletonAvatar size="lg" palette="forest" />
          <div className="flex-1 space-y-3">
            <div className="flex flex-wrap gap-2">
              <SkeletonBadge className="w-20" palette="forest" />
              <SkeletonBadge className="w-16" palette="forest" />
              <SkeletonBadge className="w-24" palette="forest" />
            </div>
            <SkeletonBox className="h-8 rounded w-2/3" palette="forest" />
            <SkeletonBox className="h-4 rounded w-1/3" palette="forest" />
          </div>
        </div>

        {/* Progress + stats */}
        <ProjectProgressBarSkeleton palette="forest" />
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="stat-card text-center space-y-2">
              <SkeletonBox
                className="h-6 rounded w-8 mx-auto"
                palette="forest"
              />
              <SkeletonBox
                className="h-5 rounded w-16 mx-auto"
                palette="forest"
              />
              <SkeletonBox
                className="h-3 rounded w-12 mx-auto"
                palette="forest"
              />
            </div>
          ))}
        </div>
      </div>

      {/* AI summary card */}
      <div className="card mt-6">
        <SkeletonBox className="h-5 rounded w-1/3 mb-3" palette="forest" />
        <SkeletonText lines={3} palette="forest" />
      </div>

      {/* Description card */}
      <div className="card mt-6">
        <SkeletonBox className="h-5 rounded w-1/4 mb-3" palette="forest" />
        <SkeletonText lines={4} palette="forest" />
      </div>

      {/* Milestones */}
      <div className="card mt-6">
        <SkeletonBox className="h-5 rounded w-1/3 mb-4" palette="forest" />
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <SkeletonBox
                  className="w-8 h-8 rounded-full"
                  palette="forest"
                />
                <SkeletonBox className="h-4 rounded w-32" palette="forest" />
              </div>
              <SkeletonBox className="h-1.5 rounded-full w-full flex-1" palette="forest" />
            </div>
          ))}
        </div>
      </div>

      {/* Updates / donation feed cards */}
      <div className="card mt-6">
        <SkeletonBox className="h-5 rounded w-1/3 mb-4" palette="forest" />
        <SkeletonList rows={3} withAvatar palette="forest" />
      </div>

      {/* Sidebar placeholders */}
      <div className="card mt-6 bg-forest-50 border-forest-200">
        <SkeletonBox className="h-5 rounded w-1/2 mb-3" palette="forest" />
        <SkeletonBox className="h-4 rounded w-3/4 mb-3" palette="forest" />
        <div className="flex flex-wrap gap-2 mb-3">
          {[1, 2, 3, 4, 5].map((i) => (
            <SkeletonBox
              key={i}
              className="h-8 rounded-lg w-14"
              palette="forest"
            />
          ))}
        </div>
        <SkeletonBox className="h-10 rounded-lg w-full" palette="forest" />
      </div>
    </div>
  );
}
