/**
 * hooks/queries.ts — React Query hooks for server-state management
 *
 * Central query and mutation hooks for donor history, leaderboard,
 * global stats, impact stats, and donation recording. Replaces the
 * manual useEffect + useState pattern with @tanstack/react-query for
 * automatic background refetching, request deduplication, cache
 * invalidation, and optimistic UI updates.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fetchDonorHistory,
  fetchLeaderboard,
  fetchGlobalStats,
  fetchProfile,
  fetchImpactDonor,
  fetchImpactGlobal,
  recordDonation,
  followProject,
  unfollowProject,
} from "@/lib/api";

// ── Query key factories ──────────────────────────────────────────────────────

export const queryKeys = {
  donorHistory: (publicKey: string | null) =>
    ["donorHistory", publicKey] as const,
  donorProfile: (publicKey: string | null) =>
    ["donorProfile", publicKey] as const,
  leaderboard: (limit = 20, period?: string) =>
    ["leaderboard", { limit, period }] as const,
  globalStats: () => ["globalStats"] as const,
  impactDonor: (publicKey: string | null) =>
    ["impactDonor", publicKey] as const,
  impactGlobal: () => ["impactGlobal"] as const,
};

// ── Query hooks ──────────────────────────────────────────────────────────────

/**
 * Fetch donation history for a donor.
 * Disabled when publicKey is null (wallet not connected).
 * Stale time: 60s — donor history changes less frequently.
 */
export function useDonorHistory(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.donorHistory(publicKey),
    queryFn: () => fetchDonorHistory(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

/**
 * Fetch a donor profile by public key.
 * Disabled when publicKey is null.
 * Stale time: 60s — profiles are rarely updated.
 */
export function useDonorProfile(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.donorProfile(publicKey),
    queryFn: () => fetchProfile(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

/**
 * Fetch the leaderboard with optional limit and period.
 * Stale time: 30s — leaderboard changes more often.
 */
export function useLeaderboard(limit = 20, period?: string) {
  return useQuery({
    queryKey: queryKeys.leaderboard(limit, period),
    queryFn: () => fetchLeaderboard(limit, period),
    staleTime: 30_000,
  });
}

/**
 * Fetch global platform statistics.
 * Stale time: 5min — global stats are relatively stable.
 */
export function useGlobalStats() {
  return useQuery({
    queryKey: queryKeys.globalStats(),
    queryFn: fetchGlobalStats,
    staleTime: 5 * 60_000,
  });
}

/**
 * Fetch donor-level impact statistics.
 * Disabled when publicKey is null.
 * Stale time: 60s.
 */
export function useImpactDonor(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.impactDonor(publicKey),
    queryFn: () => fetchImpactDonor(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

/**
 * Fetch global impact statistics.
 * Stale time: 5min.
 */
export function useImpactGlobal() {
  return useQuery({
    queryKey: queryKeys.impactGlobal(),
    queryFn: fetchImpactGlobal,
    staleTime: 5 * 60_000,
  });
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

/**
 * Record a donation after an on-chain transaction succeeds.
 * On success, invalidates:
 *  - donorHistory for the donating address
 *  - donorProfile for the donating address
 *  - leaderboard (all periods)
 *  - globalStats
 *  - impactDonor for the donating address
 */
export function useRecordDonation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: recordDonation,
    onSuccess: (_data, variables) => {
      const donor = variables.donorAddress;
      queryClient.invalidateQueries({ queryKey: queryKeys.donorHistory(donor) });
      queryClient.invalidateQueries({ queryKey: queryKeys.donorProfile(donor) });
      queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.globalStats() });
      queryClient.invalidateQueries({ queryKey: queryKeys.impactDonor(donor) });
      queryClient.invalidateQueries({ queryKey: queryKeys.impactGlobal() });
    },
  });
}

/**
 * Follow a project.
 * On success, invalidates the project query so the follow count updates.
 */
export function useFollowProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      walletAddress,
    }: {
      projectId: string;
      walletAddress: string;
    }) => followProject(projectId, walletAddress),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["project", variables.projectId],
      });
    },
  });
}

/**
 * Unfollow a project.
 * On success, invalidates the project query so the follow count updates.
 */
export function useUnfollowProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId,
      walletAddress,
    }: {
      projectId: string;
      walletAddress: string;
    }) => unfollowProject(projectId, walletAddress),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({
        queryKey: ["project", variables.projectId],
      });
    },
  });
}
