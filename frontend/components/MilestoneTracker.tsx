/**
 * components/MilestoneTracker.tsx
 * Vertical timeline showing project milestones with completion status.
 */
import { useState } from "react";
import clsx from "clsx";
import { formatDate } from "@/utils/format";

export interface Milestone {
  id: string;
  title: string;
  description: string;
  targetDate: string;
  completedAt: string | null;
  order: number;
}

interface MilestoneTrackerProps {
  milestones: Milestone[];
  isAdmin?: boolean;
  onComplete?: (milestoneId: string) => void;
}

export default function MilestoneTracker({
  milestones,
  isAdmin = false,
  onComplete,
}: MilestoneTrackerProps) {
  const [completing, setCompleting] = useState<string | null>(null);

  const sorted = [...milestones].sort((a, b) => a.order - b.order);
  const completedCount = sorted.filter((m) => m.completedAt).length;
  const progress =
    sorted.length > 0 ? Math.round((completedCount / sorted.length) * 100) : 0;

  const handleComplete = async (milestoneId: string) => {
    if (!onComplete) return;
    setCompleting(milestoneId);
    try {
      await onComplete(milestoneId);
    } finally {
      setCompleting(null);
    }
  };

  if (sorted.length === 0) {
    return (
      <div className="card text-center py-12">
        <p className="text-4xl mb-3">🎯</p>
        <p className="font-display text-lg text-[#0F172A] dark:text-[#E2E8F0] mb-1">
          No milestones yet
        </p>
        <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
          Milestones will appear here as the project sets goals.
        </p>
      </div>
    );
  }

  return (
    <div className="card animate-fade-in">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h3 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
            Project Milestones
          </h3>
          <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
            {completedCount} of {sorted.length} completed
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-bold text-[#4F46E5] dark:text-[#818CF8]">
            {progress}%
          </div>
          <div className="w-24 h-2 bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] rounded-full mt-1">
            <div
              className="h-full bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] rounded-full transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      </div>

      {/* Timeline */}
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-5 top-0 bottom-0 w-0.5 bg-[rgba(99,102,241,0.12)] dark:bg-[rgba(129,140,248,0.15)]" />

        <div className="space-y-6">
          {sorted.map((milestone, index) => {
            const isCompleted = !!milestone.completedAt;
            const isLast = index === sorted.length - 1;

            return (
              <div key={milestone.id} className="relative flex gap-4">
                {/* Circle indicator */}
                <div
                  className={clsx(
                    "relative z-10 flex items-center justify-center w-10 h-10 rounded-full border-2 flex-shrink-0",
                    isCompleted
                      ? "bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] border-0 text-white"
                      : "bg-white dark:bg-[#14142D] border-[rgba(99,102,241,0.30)] dark:border-[rgba(129,140,248,0.35)] text-[#64748B] dark:text-[#94A3B8]",
                  )}
                >
                  {isCompleted ? (
                    <svg
                      className="w-5 h-5"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={3}
                        d="M5 13l4 4L19 7"
                      />
                    </svg>
                  ) : (
                    <span className="text-sm font-bold">{index + 1}</span>
                  )}
                </div>

                {/* Content */}
                <div
                  className={clsx(
                    "flex-1 pb-6",
                    !isLast &&
                      "border-b border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]",
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h4
                        className={clsx(
                          "font-display font-semibold",
                          isCompleted
                            ? "text-[#4F46E5] dark:text-[#818CF8] line-through"
                            : "text-[#0F172A] dark:text-[#E2E8F0]",
                        )}
                      >
                        {milestone.title}
                      </h4>
                      {milestone.description && (
                        <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body mt-1">
                          {milestone.description}
                        </p>
                      )}
                    </div>
                    {isAdmin && !isCompleted && (
                      <button
                        onClick={() => handleComplete(milestone.id)}
                        disabled={completing === milestone.id}
                        className="btn-primary text-xs py-1.5 px-3 flex-shrink-0"
                      >
                        {completing === milestone.id ? "..." : "Mark Complete"}
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-3 mt-2 text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
                    <span>
                      📅 Target: {formatDate(milestone.targetDate)}
                    </span>
                    {isCompleted && milestone.completedAt && (
                      <span className="text-[#4F46E5] dark:text-[#818CF8]">
                        ✅ Completed: {formatDate(milestone.completedAt)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
