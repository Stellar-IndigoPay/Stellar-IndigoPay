/**
 * components/SLOStatusPanel.tsx
 *
 * Error-budget gauges for the platform SLOs. Only visible to authenticated
 * admins. Shows the remaining error budget as a percentage gauge with
 * color-coded thresholds (green → amber → red).
 */
import React from "react";
import type { SLOData } from "@/lib/transparencyHooks";
import { SkeletonBox } from "./Skeleton";

interface SLOStatusPanelProps {
  sloData: SLOData | null;
  isLoading?: boolean;
  error?: string | null;
}

interface SLOGaugeProps {
  label: string;
  target: string;
  errorRatio: number;
  errorBudgetRemaining: number;
}

function SLOGauge({
  label,
  target,
  errorRatio,
  errorBudgetRemaining,
}: SLOGaugeProps) {
  // Color coding based on remaining budget
  const getColor = (remaining: number) => {
    if (remaining >= 50) return { bar: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400" };
    if (remaining >= 20) return { bar: "bg-amber-500", text: "text-amber-600 dark:text-amber-400" };
    return { bar: "bg-red-500", text: "text-red-600 dark:text-red-400" };
  };

  const clampedRemaining = Math.max(0, Math.min(100, errorBudgetRemaining));
  const color = getColor(clampedRemaining);

  return (
    <div className="flex-1 min-w-[200px]">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] font-body">
          {label}
        </span>
        <span className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
          Target: {target}
        </span>
      </div>

      {/* Gauge bar */}
      <div className="h-3 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] rounded-full overflow-hidden mb-1.5">
        <div
          className={`h-full rounded-full transition-all duration-700 ease-out ${color.bar}`}
          style={{ width: `${clampedRemaining}%` }}
          role="progressbar"
          aria-valuenow={clampedRemaining}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} error budget: ${clampedRemaining.toFixed(1)}% remaining`}
        />
      </div>

      <div className="flex items-center justify-between text-xs font-body">
        <span className={`font-semibold ${color.text}`}>
          {clampedRemaining.toFixed(1)}% budget remaining
        </span>
        <span className="text-[#64748B] dark:text-[#94A3B8]">
          Error ratio: {(errorRatio * 100).toFixed(3)}%
        </span>
      </div>
    </div>
  );
}

export function SLOStatusSkeleton() {
  return (
    <div className="card p-6 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
      <SkeletonBox className="h-6 w-48 rounded mb-6" palette="indigo" />
      <div className="flex flex-wrap gap-6">
        <div className="flex-1 min-w-[200px]">
          <SkeletonBox className="h-4 w-24 rounded mb-3" palette="indigo" />
          <SkeletonBox className="h-3 w-full rounded mb-1" palette="indigo" />
          <SkeletonBox className="h-3 w-32 rounded" palette="indigo" />
        </div>
        <div className="flex-1 min-w-[200px]">
          <SkeletonBox className="h-4 w-24 rounded mb-3" palette="indigo" />
          <SkeletonBox className="h-3 w-full rounded mb-1" palette="indigo" />
          <SkeletonBox className="h-3 w-32 rounded" palette="indigo" />
        </div>
      </div>
    </div>
  );
}

export default function SLOStatusPanel({
  sloData,
  isLoading = false,
  error,
}: SLOStatusPanelProps) {
  if (isLoading) return <SLOStatusSkeleton />;

  if (error) {
    return (
      <div className="card p-6 border border-red-200 dark:border-red-800/30 bg-red-50/50 dark:bg-red-950/20">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-lg">🔒</span>
          <h3 className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0]">
            SLO Status
          </h3>
        </div>
        <p className="text-sm text-[#64748B] dark:text-[#94A3B8] font-body">
          {error.includes("Admin authentication")
            ? "Admin login required to view SLO metrics."
            : `Unable to load SLO data: ${error}`}
        </p>
      </div>
    );
  }

  if (!sloData) return null;

  return (
    <div className="card p-6 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
      <div className="flex items-center gap-2 mb-6">
        <span className="text-lg">📊</span>
        <h3 className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] text-lg">
          Service Level Objectives
        </h3>
        <span className="text-[10px] font-semibold bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8] px-2 py-0.5 rounded-full font-body">
          Admin
        </span>
      </div>

      <div className="flex flex-wrap gap-6">
        <SLOGauge
          label="Donations SLO"
          target="99.5%"
          errorRatio={sloData.donations.errorRatio}
          errorBudgetRemaining={sloData.donations.errorBudgetRemaining}
        />
        <SLOGauge
          label="Projects SLO"
          target="99.9%"
          errorRatio={sloData.projects.errorRatio}
          errorBudgetRemaining={sloData.projects.errorBudgetRemaining}
        />
      </div>

      {sloData.donations.error && (
        <p className="mt-4 text-xs text-amber-600 dark:text-amber-400 font-body">
          Note: Prometheus SLO recording rules may not be configured yet.
          {sloData.donations.error}
        </p>
      )}
    </div>
  );
}
