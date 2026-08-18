/**
 * lib/transparencyHooks.ts
 *
 * Custom hooks for the transparency dashboard data sources.
 * Each hook encapsulates its own polling strategy and error handling.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { fetchGlobalStats } from "./api";
import type { GlobalStats } from "./api";

// ── Types ──────────────────────────────────────────────────────────────────

export interface SLOData {
  donations: {
    errorRatio: number;
    errorBudgetRemaining: number;
    error?: string;
  };
  projects: {
    errorRatio: number;
    errorBudgetRemaining: number;
    error?: string;
  };
}

export interface SLOApiResponse {
  success: boolean;
  data: SLOData;
}

export type PlatformStatus = "operational" | "degraded" | "outage";

export interface HealthCheckResult {
  status: string;
  reason?: string;
}

export interface HealthResponse {
  status: string;
  checks: Record<string, HealthCheckResult>;
}

// ── Global Stats Hook (polls every 30s) ────────────────────────────────────

interface UseGlobalStatsResult {
  stats: GlobalStats | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useGlobalStats(pollIntervalMs = 30000): UseGlobalStatsResult {
  const [stats, setStats] = useState<GlobalStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStats = useCallback(async () => {
    try {
      const data = await fetchGlobalStats();
      setStats(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch stats");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStats();
    intervalRef.current = setInterval(fetchStats, pollIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchStats, pollIntervalMs]);

  return { stats, isLoading, error, refetch: fetchStats };
}

// ── SLO Data Hook (polls every 60s, admin only) ────────────────────────────

interface UseSLODataResult {
  sloData: SLOData | null;
  isLoading: boolean;
  error: string | null;
}

export function useSLOData(pollIntervalMs = 60000): UseSLODataResult {
  const [sloData, setSLOData] = useState<SLOData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchSLO = useCallback(async () => {
    try {
      const response = await fetch("/api/admin/metrics/slo", {
        credentials: "include",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 401) {
        setError("Admin authentication required");
        setSLOData(null);
        setIsLoading(false);
        return;
      }

      if (!response.ok) {
        throw new Error(`SLO endpoint responded with ${response.status}`);
      }

      const json: SLOApiResponse = await response.json();
      if (json.success && json.data) {
        setSLOData(json.data);
        setError(null);
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : "Failed to fetch SLO data");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchSLO();
    intervalRef.current = setInterval(fetchSLO, pollIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchSLO, pollIntervalMs]);

  return { sloData, isLoading, error };
}

// ── Health / Readyz Status Hook (polls every 30s) ──────────────────────────

interface UseReadyzStatusResult {
  status: PlatformStatus;
  healthData: HealthResponse | null;
  isLoading: boolean;
}

export function useReadyzStatus(
  pollIntervalMs = 30000,
): UseReadyzStatusResult {
  const [status, setStatus] = useState<PlatformStatus>("operational");
  const [healthData, setHealthData] = useState<HealthResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/readyz", {
        signal: AbortSignal.timeout(8000),
      });
      const data: HealthResponse = await response.json();
      setHealthData(data);
      if (data.status === "ready") {
        setStatus("operational");
      } else {
        const checks = Object.values(data.checks);
        const hasUnreachable = checks.some(
          (c) => c.status === "unreachable",
        );
        setStatus(hasUnreachable ? "outage" : "degraded");
      }
    } catch {
      setStatus("outage");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHealth();
    intervalRef.current = setInterval(fetchHealth, pollIntervalMs);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [fetchHealth, pollIntervalMs]);

  return { status, healthData, isLoading };
}
