/**
 * components/StatCard.tsx
 *
 * Reusable stat card used in the transparency dashboard's Impact Overview
 * section. Animates the displayed number on mount using AnimatedNumber.
 * Supports a prefix, suffix, and icon for each stat.
 */

import React, { useMemo } from "react";
import AnimatedNumber from "./AnimatedNumber";
import { SkeletonBox } from "./Skeleton";

interface StatCardProps {
  label: string;
  value: number | string;
  prefix?: string;
  suffix?: string;
  icon?: React.ReactNode;
  /** Optional formatter for the displayed value. */
  formatter?: (val: number) => string;
  /** Duration of the count-up animation in ms (default: 1500). */
  animationDuration?: number;
  /** Accessible label for screen readers (defaults to label). */
  ariaLabel?: string;
}

export function StatCardSkeleton() {
  return (
    <div className="card rounded-3xl p-6 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
      <SkeletonBox className="w-10 h-10 rounded-2xl mb-4" palette="indigo" />
      <SkeletonBox className="h-3 rounded w-1/2 mb-3" palette="indigo" />
      <SkeletonBox className="h-8 rounded w-24" palette="indigo" />
    </div>
  );
}

export default function StatCard({
  label,
  value,
  prefix = "",
  suffix = "",
  icon,
  formatter,
  animationDuration = 1500,
  ariaLabel,
}: StatCardProps) {
  const numericValue = useMemo(() => {
    if (typeof value === "string") {
      return parseFloat(value.replace(/,/g, "")) || 0;
    }
    return value || 0;
  }, [value]);

  return (
    <div
      className="card rounded-3xl p-6 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] hover:shadow-indigo transition-all group"
      role="region"
      aria-label={ariaLabel || label}
    >
      {/* Icon */}
      {icon && (
        <div className="w-10 h-10 rounded-2xl bg-[rgba(79,70,229,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-lg mb-4 group-hover:scale-110 transition-transform">
          {icon}
        </div>
      )}

      {/* Label */}
      <p className="text-[#64748B] dark:text-[#94A3B8] text-xs font-body uppercase tracking-wider font-semibold mb-1.5">
        {label}
      </p>

      {/* Animated Value */}
      <div className="font-display text-2xl sm:text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] truncate">
        <span className="text-[#4F46E5] dark:text-[#818CF8]">{prefix}</span>
        <AnimatedNumber
          value={numericValue}
          duration={animationDuration}
          formatter={formatter}
        />
        {suffix && (
          <span className="text-[#64748B] dark:text-[#94A3B8] text-sm ml-1 font-body">
            {suffix}
          </span>
        )}
      </div>
    </div>
  );
}
