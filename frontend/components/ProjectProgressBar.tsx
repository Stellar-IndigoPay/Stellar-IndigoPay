import React from "react";
import { SkeletonProgressBar, type SkeletonPalette } from "./Skeleton";

interface ProjectProgressBarProps {
  raisedXLM: string | number;
  goalXLM: string | number;
  className?: string;
}

export function ProjectProgressBarSkeleton({
  className = "",
  palette = "forest",
}: {
  className?: string;
  palette?: SkeletonPalette;
}) {
  return <SkeletonProgressBar className={className} palette={palette} />;
}

export default function ProjectProgressBar({
  raisedXLM,
  goalXLM,
  className = "",
}: ProjectProgressBarProps) {
  const parsedRaised = Number(raisedXLM);
  const parsedGoal = Number(goalXLM);
  const hasGoal = Number.isFinite(parsedGoal) && parsedGoal > 0;
  const percentage = hasGoal
    ? Math.min(100, Math.max(0, Math.round((parsedRaised / parsedGoal) * 100)))
    : 0;

  return (
    <div className={className}>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="text-sm font-semibold text-[#4F46E5] dark:text-[#818CF8]">
          {hasGoal ? `${percentage}%` : "No goal set"}
        </span>
        {hasGoal ? (
          <span className="text-xs text-[#475569] dark:text-[#94A3B8]">
            {parsedRaised.toLocaleString()} / {parsedGoal.toLocaleString()} XLM
          </span>
        ) : (
          <span className="text-xs text-[#64748B] dark:text-[#94A3B8]">
            Raised: {parsedRaised.toLocaleString()} XLM
          </span>
        )}
      </div>

      <div
        className="h-2.5 w-full overflow-hidden rounded-full bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)]"
        role="progressbar"
        aria-label="Funding progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={hasGoal ? percentage : 0}
        aria-valuetext={hasGoal ? `${percentage}% complete` : "No goal set"}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] transition-all duration-500"
          style={{ width: `${hasGoal ? percentage : 0}%` }}
        />
      </div>
    </div>
  );
}
