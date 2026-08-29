/**
 * hooks/queries.ts — React Query hooks for server-state management.
 *
 * Query keys and server-state transitions live here so pages and components
 * share one cache. Mutations update visible cached data optimistically and
 * always invalidate the affected queries after the server settles.
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
  type GlobalStats,
  type ProjectListFilters,
  type RecordDonationPayload,
} from "@/lib/api";
import { fetchProjectDiscussion } from "@/lib/stellar";
import type { ProjectDiscussionMessage } from "@/lib/stellar";
import type { ClimateProject, Donation, LeaderboardEntry } from "@/utils/types";
import { RECORD_DONATION_MUTATION_KEY } from "@/lib/queryClient";

export interface ProjectDonationsPage {
  donations: Donation[];
  nextCursor: string | null;
}

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
  projects: (filters: ProjectListFilters = {}) => ["projects", filters] as const,
  projectFacets: (filters: ProjectListFilters = {}) =>
    ["projectFacets", filters] as const,
  project: (projectId: string | null, walletAddress: string | null = null) =>
    ["project", projectId, walletAddress] as const,
  projectUpdates: (projectId: string | null) =>
    ["projectUpdates", projectId] as const,
  projectMatches: (projectId: string | null) =>
    ["projectMatches", projectId] as const,
  projectDonations: (projectId: string | null, pageSize = 10) =>
    ["projectDonations", projectId, pageSize] as const,
  projectDiscussion: (walletAddress: string | null) =>
    ["projectDiscussion", walletAddress] as const,
  subscriberCount: (projectId: string | null) =>
    ["subscriberCount", projectId] as const,
  pendingRating: (publicKey: string | null) =>
    ["pendingRating", publicKey] as const,
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

export function useProjects(
  filters: ProjectListFilters = {},
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.projects(filters),
    queryFn: () => fetchProjects(filters),
    enabled,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
}

export function useProjectFacets(
  filters: ProjectListFilters = {},
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.projectFacets(filters),
    queryFn: () => fetchProjectFacets(filters),
    enabled,
    staleTime: 30_000,
  });
}

export function useProject(
  projectId: string | null,
  walletAddress: string | null = null,
) {
  return useQuery({
    queryKey: queryKeys.project(projectId, walletAddress),
    queryFn: () => fetchProject(projectId!, walletAddress || undefined),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useProjectUpdates(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.projectUpdates(projectId),
    queryFn: () => fetchProjectUpdates(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useProjectMatches(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.projectMatches(projectId),
    queryFn: () => fetchProjectMatches(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function useProjectDiscussion(walletAddress: string | null) {
  return useQuery<ProjectDiscussionMessage[]>({
    queryKey: queryKeys.projectDiscussion(walletAddress),
    queryFn: () => fetchProjectDiscussion(walletAddress!, 50),
    enabled: !!walletAddress,
    staleTime: 30_000,
  });
}

export function useSubscriberCount(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.subscriberCount(projectId),
    queryFn: () => fetchSubscriberCount(projectId!),
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

export function usePendingRating(publicKey: string | null) {
  return useQuery({
    queryKey: queryKeys.pendingRating(publicKey),
    queryFn: () => fetchPendingRating(publicKey!),
    enabled: !!publicKey,
    staleTime: 60_000,
  });
}

export function useProjectDonations(projectId: string | null, pageSize = 10) {
  return useInfiniteQuery({
    queryKey: queryKeys.projectDonations(projectId, pageSize),
    queryFn: ({ pageParam }) =>
      fetchProjectDonations(projectId!, pageSize, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    enabled: !!projectId,
    staleTime: 30_000,
  });
}

// ── Donation mutation helpers ────────────────────────────────────────────────

function numericAmount(payload: RecordDonationPayload): number {
  const value = Number.parseFloat(payload.amountXLM ?? payload.amount ?? "0");
  return Number.isFinite(value) ? value : 0;
}

function addAmount(current: string, amount: number): string {
  const value = Number.parseFloat(current);
  return (Number.isFinite(value) ? value : 0) + amount + "";
}

function makeOptimisticDonation(payload: RecordDonationPayload): Donation {
  const currency = payload.currency ?? "XLM";
  const amount = payload.amountXLM ?? payload.amount ?? "0";
  const id = `optimistic-${payload.idempotencyKey ?? payload.transactionHash}`;
  return {
    id,
    projectId: payload.projectId,
    donorAddress: payload.donorAddress,
    ...(currency === "XLM" ? { amountXLM: amount } : {}),
    amount,
    currency,
    message: payload.message,
    transactionHash: payload.transactionHash,
    createdAt: new Date().toISOString(),
  };
}

function prependDonation(
  donations: Donation[] | undefined,
  donation: Donation,
): Donation[] | undefined {
  if (!donations) return donations;
  if (
    donations.some(
      (item) =>
        item.id === donation.id ||
        item.transactionHash === donation.transactionHash,
    )
  ) {
    return donations;
  }
  return [donation, ...donations];
}

function prependDonationPage(
  data: InfiniteData<ProjectDonationsPage> | undefined,
  donation: Donation,
): InfiniteData<ProjectDonationsPage> | undefined {
  if (!data || data.pages.length === 0) return data;
  if (
    data.pages.some((page) =>
      page.donations.some(
        (item) =>
          item.id === donation.id ||
          item.transactionHash === donation.transactionHash,
      ),
    )
  ) {
    return data;
  }
  return {
    ...data,
    pages: data.pages.map((page, index) =>
      index === 0
        ? { ...page, donations: [donation, ...page.donations] }
        : page,
    ),
  };
}

function removeOptimisticDonation(
  donations: Donation[] | undefined,
  optimisticId: string,
): Donation[] | undefined {
  if (!donations || !donations.some((item) => item.id === optimisticId)) {
    return donations;
  }
  return donations.filter((item) => item.id !== optimisticId);
}

function removeOptimisticDonationPage(
  data: InfiniteData<ProjectDonationsPage> | undefined,
  optimisticId: string,
): InfiniteData<ProjectDonationsPage> | undefined {
  if (!data) return data;
  let changed = false;
  const pages = data.pages.map((page) => {
    const donations = page.donations.filter((item) => item.id !== optimisticId);
    const pageChanged = donations.length !== page.donations.length;
    if (pageChanged) changed = true;
    return pageChanged ? { ...page, donations } : page;
  });
  return changed ? { ...data, pages } : data;
}

function subtractAmount(current: string, amount: number): string {
  const value = Number.parseFloat(current);
  return (Number.isFinite(value) ? value : 0) - amount + "";
}

interface DonationMutationContext {
  optimisticId: string;
  amount: number;
  isXlm: boolean;
}

async function cancelDonationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  donorAddress: string,
) {
  await Promise.all([
    queryClient.cancelQueries({ queryKey: ["donorHistory", donorAddress] }),
    queryClient.cancelQueries({ queryKey: ["donorProfile", donorAddress] }),
    queryClient.cancelQueries({ queryKey: ["impactDonor", donorAddress] }),
    queryClient.cancelQueries({ queryKey: ["project", projectId] }),
    queryClient.cancelQueries({ queryKey: ["projects"] }),
    queryClient.cancelQueries({ queryKey: ["projectDonations", projectId] }),
    queryClient.cancelQueries({ queryKey: ["leaderboard"] }),
    queryClient.cancelQueries({ queryKey: ["globalStats"] }),
    queryClient.cancelQueries({ queryKey: ["impactGlobal"] }),
  ]);
}

async function invalidateDonationQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  projectId: string,
  donorAddress: string,
) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: ["donorHistory", donorAddress] }),
    queryClient.invalidateQueries({ queryKey: ["donorProfile", donorAddress] }),
    queryClient.invalidateQueries({ queryKey: ["impactDonor", donorAddress] }),
    queryClient.invalidateQueries({ queryKey: ["project", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["projects"] }),
    queryClient.invalidateQueries({ queryKey: ["projectDonations", projectId] }),
    queryClient.invalidateQueries({ queryKey: ["leaderboard"] }),
    queryClient.invalidateQueries({ queryKey: ["globalStats"] }),
    queryClient.invalidateQueries({ queryKey: ["impactGlobal"] }),
  ]);
}

/** Record a completed on-chain donation with optimistic cache updates. */
export function useRecordDonation() {
  const queryClient = useQueryClient();

  return useMutation<Donation, unknown, RecordDonationPayload, DonationMutationContext>({
    mutationKey: [RECORD_DONATION_MUTATION_KEY],
    mutationFn: recordDonation,
    onMutate: async (variables) => {
      await cancelDonationQueries(
        queryClient,
        variables.projectId,
        variables.donorAddress,
      );

      const donation = makeOptimisticDonation(variables);
      const amount = numericAmount(variables);
      const isXlm = !variables.currency || variables.currency === "XLM";

      queryClient.setQueriesData<Donation[]>(
        { queryKey: ["donorHistory", variables.donorAddress] },
        (old) => prependDonation(old, donation),
      );
      queryClient.setQueriesData<InfiniteData<ProjectDonationsPage>>(
        { queryKey: ["projectDonations", variables.projectId] },
        (old) => prependDonationPage(old, donation),
      );
      queryClient.setQueriesData<ClimateProject>(
        { queryKey: ["project", variables.projectId] },
        (old) =>
          old && isXlm
            ? {
                ...old,
                raisedXLM: addAmount(old.raisedXLM, amount),
              }
            : old,
      );
      queryClient.setQueriesData<ClimateProject[]>(
        { queryKey: ["projects"] },
        (old) =>
          old?.map((project) =>
            project.id === variables.projectId && isXlm
              ? {
                  ...project,
                  raisedXLM: addAmount(project.raisedXLM, amount),
                }
              : project,
          ),
      );
      queryClient.setQueriesData<GlobalStats>(
        { queryKey: ["globalStats"] },
        (old) =>
          old && isXlm
            ? {
                ...old,
                totalXLMRaised: addAmount(old.totalXLMRaised, amount),
                totalDonations: old.totalDonations + 1,
              }
            : old,
      );
      queryClient.setQueriesData<LeaderboardEntry[]>(
        { queryKey: ["leaderboard"] },
        (old) =>
          old?.map((entry) =>
            entry.publicKey === variables.donorAddress && isXlm
              ? {
                  ...entry,
                  totalDonatedXLM: addAmount(entry.totalDonatedXLM, amount),
                }
              : entry,
          ),
      );
      queryClient.setQueriesData<{ totalDonatedXLM: string }>(
        { queryKey: ["donorProfile", variables.donorAddress] },
        (old) =>
          old && isXlm
            ? { ...old, totalDonatedXLM: addAmount(old.totalDonatedXLM, amount) }
            : old,
      );
      queryClient.setQueriesData<{ totalDonatedXLM: string }>(
        { queryKey: ["impactDonor", variables.donorAddress] },
        (old) =>
          old && isXlm
            ? { ...old, totalDonatedXLM: addAmount(old.totalDonatedXLM, amount) }
            : old,
      );

      return { optimisticId: donation.id, amount, isXlm };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;

      queryClient.setQueriesData<Donation[]>(
        { queryKey: ["donorHistory", _variables.donorAddress] },
        (old) => removeOptimisticDonation(old, context.optimisticId),
      );
      queryClient.setQueriesData<InfiniteData<ProjectDonationsPage>>(
        { queryKey: ["projectDonations", _variables.projectId] },
        (old) => removeOptimisticDonationPage(old, context.optimisticId),
      );

      if (!context.isXlm) return;

      queryClient.setQueriesData<ClimateProject>(
        { queryKey: ["project", _variables.projectId] },
        (old) =>
          old
            ? { ...old, raisedXLM: subtractAmount(old.raisedXLM, context.amount) }
            : old,
      );
      queryClient.setQueriesData<ClimateProject[]>(
        { queryKey: ["projects"] },
        (old) =>
          old?.map((project) =>
            project.id === _variables.projectId
              ? { ...project, raisedXLM: subtractAmount(project.raisedXLM, context.amount) }
              : project,
          ),
      );
      queryClient.setQueriesData<GlobalStats>(
        { queryKey: ["globalStats"] },
        (old) =>
          old
            ? {
                ...old,
                totalXLMRaised: subtractAmount(old.totalXLMRaised, context.amount),
                totalDonations: old.totalDonations - 1,
              }
            : old,
      );
      queryClient.setQueriesData<LeaderboardEntry[]>(
        { queryKey: ["leaderboard"] },
        (old) =>
          old?.map((entry) =>
            entry.publicKey === _variables.donorAddress
              ? {
                  ...entry,
                  totalDonatedXLM: subtractAmount(
                    entry.totalDonatedXLM,
                    context.amount,
                  ),
                }
              : entry,
          ),
      );
      queryClient.setQueriesData<{ totalDonatedXLM: string }>(
        { queryKey: ["donorProfile", _variables.donorAddress] },
        (old) =>
          old
            ? {
                ...old,
                totalDonatedXLM: subtractAmount(old.totalDonatedXLM, context.amount),
              }
            : old,
      );
      queryClient.setQueriesData<{ totalDonatedXLM: string }>(
        { queryKey: ["impactDonor", _variables.donorAddress] },
        (old) =>
          old
            ? {
                ...old,
                totalDonatedXLM: subtractAmount(old.totalDonatedXLM, context.amount),
              }
            : old,
      );
    },
    onSettled: (_data, _error, variables) => {
      // Let the last concurrent donation reconcile the shared cache. An
      // earlier settlement must not refetch over another mutation's optimistic
      // layer.
      if (
        queryClient.isMutating({ mutationKey: [RECORD_DONATION_MUTATION_KEY] }) > 1
      ) {
        return;
      }
      return invalidateDonationQueries(
        queryClient,
        variables.projectId,
        variables.donorAddress,
      );
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
        queryKey: ["project", variables.projectId],
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
        queryKey: ["project", variables.projectId],
      });
    },
  });
}
