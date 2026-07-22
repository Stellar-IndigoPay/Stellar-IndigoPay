/**
 * components/HealthBanner.tsx
 *
 * Displays the current platform-wide health status on the transparency
 * dashboard. Polls GET /api/readyz every 30 seconds for automatic updates.
 *
 * States:
 *   🟢 All Systems Operational  — /api/readyz returns 200, all checks OK
 *   🟡 Degraded Performance     — some downstream (replica, RPC) degraded
 *   🔴 Service Disruption       — backend unreachable or major outage
 */
import { useState, useEffect, useCallback, useRef } from "react";
import { SkeletonBox } from "./Skeleton";

export type PlatformStatus = "operational" | "degraded" | "outage" | "loading";

interface HealthBannerProps {
  initialStatus?: PlatformStatus;
  /** Override polling interval in ms (default: 30000). */
  pollIntervalMs?: number;
}

interface HealthCheckResult {
  status: string;
  reason?: string;
}

interface HealthResponse {
  status: string;
  checks: Record<string, HealthCheckResult>;
}

function determineStatus(data: HealthResponse | null): PlatformStatus {
  if (!data) return "outage";
  if (data.status === "ready") return "operational";

  // Check if any subsystems are degraded (vs unreachable)
  const checks = Object.values(data.checks);
  const hasDegraded = checks.some(
    (c) => c.status === "degraded" || c.status === "unreachable",
  );
  const hasUnreachable = checks.some((c) => c.status === "unreachable");

  if (hasUnreachable) return "outage";
  if (hasDegraded) return "degraded";
  return "outage";
}

const STATUS_CONFIG: Record<
  PlatformStatus,
  { icon: string; label: string; bg: string; text: string; dot: string }
> = {
  operational: {
    icon: "🟢",
    label: "All Systems Operational",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
    text: "text-emerald-800 dark:text-emerald-200",
    dot: "bg-emerald-500",
  },
  degraded: {
    icon: "🟡",
    label: "Degraded Performance",
    bg: "bg-amber-50 dark:bg-amber-950/30",
    text: "text-amber-800 dark:text-amber-200",
    dot: "bg-amber-500",
  },
  outage: {
    icon: "🔴",
    label: "Service Disruption",
    bg: "bg-red-50 dark:bg-red-950/30",
    text: "text-red-800 dark:text-red-200",
    dot: "bg-red-500",
  },
  loading: {
    icon: "⚪",
    label: "Checking status…",
    bg: "bg-slate-50 dark:bg-slate-900/30",
    text: "text-slate-500 dark:text-slate-400",
    dot: "bg-slate-400",
  },
};

export default function HealthBanner({
  initialStatus = "loading",
  pollIntervalMs = 30000,
}: HealthBannerProps) {
  const [status, setStatus] = useState<PlatformStatus>(initialStatus);
  const [details, setDetails] = useState<HealthResponse | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/readyz", {
        signal: AbortSignal.timeout(8000),
      });
      const data: HealthResponse = await response.json();
      setDetails(data);
      setStatus(determineStatus(data));
    } catch {
      setDetails(null);
      setStatus("outage");
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    intervalRef.current = setInterval(fetchHealth, pollIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth, pollIntervalMs]);

  if (status === "loading") {
    return (
      <div className="rounded-xl p-4 mb-6 bg-slate-50 dark:bg-slate-900/30">
        <SkeletonBox className="h-6 w-64 rounded" palette="indigo" />
      </div>
    );
  }

  const config = STATUS_CONFIG[status];

  return (
    <div
      className={`rounded-xl border border-current/10 p-4 mb-6 transition-colors duration-500 ${config.bg}`}
      role="status"
      aria-live="polite"
      aria-label={`Platform status: ${config.label}`}
    >
      <div className="flex items-center gap-3">
        <span
          className={`w-2.5 h-2.5 rounded-full ${config.dot} animate-pulse shadow-sm`}
          aria-hidden="true"
        />
        <span className={`text-sm font-semibold ${config.text}`}>
          {config.icon} {config.label}
        </span>
        {details && (
          <span className="text-xs text-current/60 ml-auto font-body">
            Last checked: {new Date().toLocaleTimeString()}
          </span>
        )}
      </div>

      {/* Expandable detail row when degraded or outage */}
      {(status === "degraded" || status === "outage") && details && (
        <div className="mt-3 pt-3 border-t border-current/10 space-y-1">
          {Object.entries(details.checks)
            .filter(([_, c]) => c.status === "degraded" || c.status === "unreachable")
            .map(([name, check]) => (
              <div
                key={name}
                className="flex items-center gap-2 text-xs font-body"
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    check.status === "unreachable"
                      ? "bg-red-500"
                      : "bg-amber-500"
                  }`}
                />
                <span className="font-medium text-current/80 capitalize">
                  {name.replace(/_/g, " ")}
                </span>
                <span className="text-current/60">
                  {check.status === "unreachable" ? "Unreachable" : "Degraded"}
                  {check.reason ? ` — ${check.reason}` : ""}
                </span>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
