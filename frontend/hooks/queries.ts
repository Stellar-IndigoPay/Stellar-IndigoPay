Here is the complete, resolved `hooks/queries.ts` code ready to paste back:

```typescript
/**
 * hooks/queries.ts — React Query hooks for server-state management
 *
 * Central query and mutation hooks for donor history, leaderboard,
 * global stats, impact stats, project queries, likes, and donation recording.
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
  toggleUpdateLike,
  fetchUpdateLikes,
  fetchProject,
} from "@/lib/api";
import type { ClimateProject } from "@/utils/types";
import { toast } from "sonner";

// ── Query key factories ──────────────────────────────────────────────────────

export const queryKeys = {
  project: (projectId: string) => ["project", projectId] as const,
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
  updateLikes: (updateId: string) => ["updateLikes", updateId] as const,
};

export interface LikeState {
  liked: boolean;
  likeCount: number;
}

// ── Query hooks ──────────────────────────────────────────────────────────────

/**
 * Fetch project details by ID.
 * Enabled when projectId is provided.
 */
export function useProjectQuery(
  projectId: string,
  initialData?: ClimateProject,
  publicKey?: string,
) {
  return useQuery<ClimateProject>({
    queryKey: queryKeys.project(projectId),
    queryFn: () => fetchProject(projectId, publicKey),
    initialData,
    enabled: !!projectId,
  });
}

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

/**
 * Fetch like state for a project update.
 */
export function useUpdateLikesQuery(updateId: string, publicKey?: string) {
  return useQuery<LikeState>({
    queryKey: queryKeys.updateLikes(updateId),
    queryFn: () => fetchUpdateLikes(updateId, publicKey),
    enabled: !!updateId,
  });
}

// ── Mutation hooks ───────────────────────────────────────────────────────────

/**
 * Record a donation after an on-chain transaction succeeds.
 * On success, invalidates related donor and global queries.
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
 * Follow a project with optimistic UI updates and rollback on error.
 * Supports passing string `projectId` or object `{ projectId, walletAddress }`.
 */
export function useFollowProject(
  publicKey?: string,
  options?: { onError?: (err: any) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      args: string | { projectId: string; walletAddress: string },
    ) => {
      const pid = typeof args === "string" ? args : args.projectId;
      const wallet = typeof args === "string" ? publicKey! : args.walletAddress;
      return followProject(pid, wallet);
    },
    onMutate: async (args) => {
      const projectId = typeof args === "string" ? args : args.projectId;

      await queryClient.cancelQueries({ queryKey: queryKeys.project(projectId) });

      const previous = queryClient.getQueryData<ClimateProject>(
        queryKeys.project(projectId),
      );

      queryClient.setQueryData<ClimateProject>(
        queryKeys.project(projectId),
        (old) =>
          old
            ? {
                ...old,
                isFollowing: true,
                followCount: (old.followCount || 0) + 1,
              }
            : undefined,
      );

      return { previous, projectId };
    },
    onError: (err, args, context) => {
      const projectId =
        context?.projectId || (typeof args === "string" ? args : args.projectId);

      if (context?.previous) {
        queryClient.setQueryData(queryKeys.project(projectId), context.previous);
      }
      toast.error("Failed to follow project. Please try again.");
      if (options?.onError) {
        options.onError(err);
      }
    },
    onSettled: (_data, _error, args, context) => {
      const projectId =
        context?.projectId || (typeof args === "string" ? args : args.projectId);
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    },
  });
}

/**
 * Unfollow a project with optimistic UI updates and rollback on error.
 * Supports passing string `projectId` or object `{ projectId, walletAddress }`.
 */
export function useUnfollowProject(
  publicKey?: string,
  options?: { onError?: (err: any) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (
      args: string | { projectId: string; walletAddress: string },
    ) => {
      const pid = typeof args === "string" ? args : args.projectId;
      const wallet = typeof args === "string" ? publicKey! : args.walletAddress;
      return unfollowProject(pid, wallet);
    },
    onMutate: async (args) => {
      const projectId = typeof args === "string" ? args : args.projectId;

      await queryClient.cancelQueries({ queryKey: queryKeys.project(projectId) });

      const previous = queryClient.getQueryData<ClimateProject>(
        queryKeys.project(projectId),
      );

      queryClient.setQueryData<ClimateProject>(
        queryKeys.project(projectId),
        (old) =>
          old
            ? {
                ...old,
                isFollowing: false,
                followCount: Math.max((old.followCount || 0) - 1, 0),
              }
            : undefined,
      );

      return { previous, projectId };
    },
    onError: (err, args, context) => {
      const projectId =
        context?.projectId || (typeof args === "string" ? args : args.projectId);

      if (context?.previous) {
        queryClient.setQueryData(queryKeys.project(projectId), context.previous);
      }
      toast.error("Failed to unfollow project. Please try again.");
      if (options?.onError) {
        options.onError(err);
      }
    },
    onSettled: (_data, _error, args, context) => {
      const projectId =
        context?.projectId || (typeof args === "string" ? args : args.projectId);
      queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
    },
  });
}

/**
 * Toggle like status on a project update with optimistic update and rollback.
 */
export function useToggleUpdateLike(
  publicKey: string,
  options?: { onError?: (err: any) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updateId: string) => toggleUpdateLike(updateId, publicKey),
    onMutate: async (updateId) => {
      await queryClient.cancelQueries({
        queryKey: queryKeys.updateLikes(updateId),
      });

      const previous = queryClient.getQueryData<LikeState>(
        queryKeys.updateLikes(updateId),
      );

      queryClient.setQueryData<LikeState>(
        queryKeys.updateLikes(updateId),
        (old) => {
          const liked = !old?.liked;
          const likeCount = old?.liked
            ? Math.max((old.likeCount || 0) - 1, 0)
            : (old?.likeCount || 0) + 1;
          return { liked, likeCount };
        },
      );

      return { previous, updateId };
    },
    onError: (err, updateId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(
          queryKeys.updateLikes(updateId),
          context.previous,
        );
      }
      toast.error("Failed to update like. Please try again.");
      if (options?.onError) {
        options.onError(err);
      }
    },
    onSettled: (_data, _error, updateId) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.updateLikes(updateId),
      });
    },
  });
}
```
    },
  });
}
