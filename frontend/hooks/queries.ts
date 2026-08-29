/**
 * hooks/queries.ts — React Query hooks for server-state management
 */
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  keepPreviousData,
  type InfiniteData,
} from "@tanstack/react-query";
import {
  fetchDonorHistory,
  fetchLeaderboard,
  fetchGlobalStats,
  fetchProfile,
  fetchImpactDonor,
  fetchImpactGlobal,
  fetchProjects,
  fetchProject,
  fetchProjectFacets,
  fetchProjectMatches,
  fetchProjectUpdates,
  fetchProjectDonations,
  fetchSubscriberCount,
  fetchPendingRating,
  recordDonation,
  followProject,
  unfollowProject,
  fetchProjects,
  fetchProject,
  fetchProjectUpdates,
  fetchProjectMatches,
  fetchProjectDonations,
} from "@/lib/api";
import { getXLMBalance } from "@/lib/stellar";
import { getDueMonthlySubscriptionsForDonor } from "@/lib/monthlyGiving";

// ── Query key factories ──────────────────────────────────────────────────────

export const queryKeys = {
  donorHistory: (publicKey: string | null) => ["donorHistory", publicKey] as const,
  donorProfile: (publicKey: string | null) => ["donorProfile", publicKey] as const,
  leaderboard: (limit = 20, period?: string) => ["leaderboard", { limit, period }] as const,
  globalStats: () => ["globalStats"] as const,
  impactDonor: (publicKey: string | null) => ["impactDonor", publicKey] as const,
  impactGlobal: () => ["impactGlobal"] as const,
  projects: () => ["projects"] as const,
  project: (id: string) => ["project", id] as const,
  projectUpdates: (id: string) => ["projectUpdates", id] as const,
  projectMatches: (id: string) => ["projectMatches", id] as const,
  projectDonations: (id: string, cursor?: string | null) => ["projectDonations", id, cursor] as const,
  balance: (publicKey: string | null) => ["balance", publicKey] as const,
  pendingRating: (publicKey: string | null) => ["pendingRating", publicKey] as const,
  dueSubscriptions: (publicKey: string | null) => ["dueSubscriptions", publicKey] as const,
};

// ── Query hooks ──────────────────────────────────────────────────────────────

export function useDonorHistory(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.donorHistory(publicKey),
    queryFn: () => fetchDonorHistory(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

export function useDonorProfile(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.donorProfile(publicKey),
    queryFn: () => fetchProfile(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

export function useLeaderboard(limit = 20, period?: string) {
  return useQuery({
    queryKey: queryKeys.leaderboard(limit, period),
    queryFn: () => fetchLeaderboard(limit, period),
    staleTime: 30_000,
  });
}

export function useGlobalStats() {
  return useQuery({
    queryKey: queryKeys.globalStats(),
    queryFn: fetchGlobalStats,
    staleTime: 5 * 60_000,
  });
}

export function useImpactDonor(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.impactDonor(publicKey),
    queryFn: () => fetchImpactDonor(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

export function useImpactGlobal() {
  return useQuery({
    queryKey: queryKeys.impactGlobal(),
    queryFn: fetchImpactGlobal,
    staleTime: 5 * 60_000,
  });
}

export function useProjects() {
  return useQuery({
    queryKey: queryKeys.projects(),
    queryFn: () => fetchProjects(),
    staleTime: 30_000,
  });
}

export function useProject(id: string | null, publicKey?: string) {
  return useQuery({
    queryKey: queryKeys.project(id!),
    queryFn: () => fetchProject(id!, publicKey),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useProjectUpdates(id: string | null) {
  return useQuery({
    queryKey: queryKeys.projectUpdates(id!),
    queryFn: () => fetchProjectUpdates(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useProjectMatches(id: string | null) {
  return useQuery({
    queryKey: queryKeys.projectMatches(id!),
    queryFn: () => fetchProjectMatches(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useProjectDonations(id: string | null, limit = 10, cursor?: string | null) {
  return useQuery({
    queryKey: queryKeys.projectDonations(id!, cursor),
    queryFn: () => fetchProjectDonations(id!, limit, cursor || undefined),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useBalance(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.balance(publicKey),
    queryFn: () => getXLMBalance(publicKey!),
    enabled: !!publicKey,
    staleTime: 30_000,
  });
}

export function usePendingRating(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.pendingRating(publicKey),
    queryFn: () => fetch(`${process.env.NEXT_PUBLIC_API_URL || ""}/api/v1/ratings/pending?donorAddress=${publicKey}`).then(r => r.json()).then(res => res?.success && res.data ? res.data : null),
    enabled: !!publicKey,
    staleTime: 30_000,
  });
}

export function useDueSubscriptions(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.dueSubscriptions(publicKey),
    queryFn: () => getDueMonthlySubscriptionsForDonor(publicKey!),
    enabled: !!publicKey,
    staleTime: 30_000,
  });
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

export function useRecordDonation() {
  const queryClient = useQueryClient();

  return useMutation<Donation, unknown, RecordDonationPayload, DonationMutationContext>({
    mutationKey: [RECORD_DONATION_MUTATION_KEY],
    mutationFn: recordDonation,
    onMutate: async (variables) => {
      // Optimistic update
      const donor = variables.donorAddress;
      const projectId = variables.projectId;

      // Cancel any outgoing refetches so they don't overwrite our optimistic update
      await queryClient.cancelQueries({ queryKey: queryKeys.projectDonations(projectId, null) });

      // Snapshot the previous value
      const previousDonations = queryClient.getQueryData(queryKeys.projectDonations(projectId, null));

      // Optimistically update to the new value
      queryClient.setQueryData(queryKeys.projectDonations(projectId, null), (old: any) => {
        const newDonation = {
          id: `opt-${Date.now()}`,
          projectId,
          donorAddress: donor,
          amountXLM: variables.amountXLM,
          amount: variables.amountXLM,
          currency: 'XLM',
          transactionHash: variables.transactionHash || 'pending',
          createdAt: new Date().toISOString(),
          anonymous: (variables as any).anonymous || false,
          message: variables.message || '',
        };
        if (!old) {
          return { donations: [newDonation], nextCursor: null };
        }
        return {
          ...old,
          donations: [newDonation, ...old.donations],
        };
      });

      return { previousDonations, projectId };
    },
    onError: (err, variables, context: any) => {
      if (context?.previousDonations) {
        queryClient.setQueryData(queryKeys.projectDonations(context.projectId, null), context.previousDonations);
      }
    },
    onSuccess: (_data, variables) => {
      const donor = variables.donorAddress;
      queryClient.invalidateQueries({ queryKey: queryKeys.donorHistory(donor) });
      queryClient.invalidateQueries({ queryKey: queryKeys.donorProfile(donor) });
      queryClient.invalidateQueries({ queryKey: ["leaderboard"] });
      queryClient.invalidateQueries({ queryKey: queryKeys.globalStats() });
      queryClient.invalidateQueries({ queryKey: queryKeys.impactDonor(donor) });
      queryClient.invalidateQueries({ queryKey: queryKeys.impactGlobal() });
    },
    onSettled: (_data, _error, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.projectDonations(variables.projectId, null) });
    },
  });
}

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
        queryKey: queryKeys.project(variables.projectId),
      });
    },
  });
}

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
        queryKey: queryKeys.project(variables.projectId),
      });
    },
  });
}
