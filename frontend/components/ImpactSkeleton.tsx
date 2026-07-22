/**
 * components/ImpactSkeleton.tsx
 *
 * Full-page loading placeholder that mirrors the global impact dashboard:
 *   - header
 *   - 5 stat cards
 *   - world map card
 *   - category breakdown card
 *   - top impact leaders card
 *   - community CTA
 *
 * Uses only the existing primitives in `components/Skeleton.tsx`.
 */
import {
  SkeletonBox,
  SkeletonText,
  SkeletonAvatar,
} from "@/components/Skeleton";

export default function ImpactSkeleton() {
  return (
    <div className="min-h-screen bg-[#FAFAFE] dark:bg-[#0A0A1A] font-body text-[#0F172A] dark:text-[#E2E8F0] pb-20">
      <main className="max-w-7xl mx-auto px-4 py-12 sm:px-6 lg:px-8">
        {/* Header */}
        <div className="text-center mb-16">
          <SkeletonBox className="h-12 rounded w-80 mx-auto mb-4" palette="indigo" />
          <SkeletonBox className="h-4 rounded w-96 mx-auto" palette="indigo" />
        </div>

        {/* Global stats grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-16">
          {[1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="card rounded-3xl p-8 border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
            >
              <SkeletonBox
                className="w-12 h-12 rounded-2xl mb-6"
                palette="indigo"
              />
              <SkeletonBox
                className="h-3 rounded w-1/2 mb-3"
                palette="indigo"
              />
              <SkeletonBox className="h-8 rounded w-24" palette="indigo" />
            </div>
          ))}
        </div>

        {/* World map card */}
        <div className="card rounded-3xl p-8 mb-16">
          <SkeletonBox className="h-7 rounded w-48 mb-6" palette="indigo" />
          <SkeletonBox className="h-72 rounded-2xl w-full" palette="indigo" />
        </div>

        {/* Category breakdown */}
        <div className="card rounded-3xl p-8 mb-16">
          <SkeletonBox className="h-7 rounded w-56 mb-6" palette="indigo" />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[1, 2, 3, 4].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-2xl border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] p-5"
              >
                <div className="space-y-2">
                  <SkeletonBox className="h-4 rounded w-32" palette="indigo" />
                  <SkeletonBox className="h-3 rounded w-24" palette="indigo" />
                </div>
                <SkeletonBox className="h-5 rounded w-20" palette="indigo" />
              </div>
            ))}
          </div>
        </div>

        {/* Top impact leaders */}
        <div className="card rounded-3xl shadow-indigo p-8 mb-16">
          <SkeletonBox className="h-7 rounded w-52 mb-8" palette="indigo" />
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex flex-col items-center text-center p-6 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] rounded-2xl"
              >
                <SkeletonAvatar size="lg" palette="indigo" />
                <SkeletonBox className="h-4 rounded w-28 mt-4" palette="indigo" />
                <SkeletonBox className="h-3 rounded w-20 mt-2" palette="indigo" />
                <SkeletonBox className="h-6 rounded-full w-16 mt-4" palette="indigo" />
              </div>
            ))}
          </div>
        </div>

        {/* Community CTA */}
        <div className="text-center py-10">
          <SkeletonBox className="h-7 rounded w-64 mx-auto mb-4" palette="indigo" />
          <SkeletonText lines={1} widths={["w-1/3"]} className="max-w-xs mx-auto mb-6" palette="indigo" />
          <SkeletonBox className="h-12 rounded-xl w-48 mx-auto" palette="indigo" />
        </div>
      </main>
    </div>
  );
}
