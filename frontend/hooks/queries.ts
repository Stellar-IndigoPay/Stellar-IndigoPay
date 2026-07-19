import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  followProject,
  unfollowProject,
  toggleUpdateLike,
  fetchUpdateLikes,
  fetchProject,
} from "../lib/api";
import type { ClimateProject } from "../utils/types";
import { toast } from "sonner";

export function useProjectQuery(
  projectId: string,
  initialData?: ClimateProject,
  publicKey?: string,
) {
  return useQuery<ClimateProject>({
    queryKey: ["project", projectId],
    queryFn: () => fetchProject(projectId, publicKey),
    initialData,
    enabled: !!projectId,
  });
}

export function useFollowProject(
  publicKey: string,
  options?: { onError?: (err: any) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => followProject(projectId, publicKey),
    onMutate: async (projectId) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });

      // Snapshot previous value
      const previous = queryClient.getQueryData<ClimateProject>([
        "project",
        projectId,
      ]);

      // Optimistically update
      queryClient.setQueryData<ClimateProject>(
        ["project", projectId],
        (old) =>
          old
            ? {
                ...old,
                isFollowing: true,
                followCount: (old.followCount || 0) + 1,
              }
            : undefined,
      );

      return { previous };
    },
    onError: (err, projectId, context) => {
      // Rollback
      if (context?.previous) {
        queryClient.setQueryData(["project", projectId], context.previous);
      }
      toast.error("Failed to follow project. Please try again.");
      if (options?.onError) {
        options.onError(err);
      }
    },
    onSettled: (data, error, projectId) => {
      // Refetch to ensure server state
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}

export function useUnfollowProject(
  publicKey: string,
  options?: { onError?: (err: any) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) => unfollowProject(projectId, publicKey),
    onMutate: async (projectId) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["project", projectId] });

      // Snapshot previous value
      const previous = queryClient.getQueryData<ClimateProject>([
        "project",
        projectId,
      ]);

      // Optimistically update
      queryClient.setQueryData<ClimateProject>(
        ["project", projectId],
        (old) =>
          old
            ? {
                ...old,
                isFollowing: false,
                followCount: Math.max((old.followCount || 0) - 1, 0),
              }
            : undefined,
      );

      return { previous };
    },
    onError: (err, projectId, context) => {
      // Rollback
      if (context?.previous) {
        queryClient.setQueryData(["project", projectId], context.previous);
      }
      toast.error("Failed to unfollow project. Please try again.");
      if (options?.onError) {
        options.onError(err);
      }
    },
    onSettled: (data, error, projectId) => {
      // Refetch to ensure server state
      queryClient.invalidateQueries({ queryKey: ["project", projectId] });
    },
  });
}

export interface LikeState {
  liked: boolean;
  likeCount: number;
}

export function useUpdateLikesQuery(updateId: string, publicKey?: string) {
  return useQuery<LikeState>({
    queryKey: ["updateLikes", updateId],
    queryFn: () => fetchUpdateLikes(updateId, publicKey),
    enabled: !!updateId,
  });
}

export function useToggleUpdateLike(
  publicKey: string,
  options?: { onError?: (err: any) => void },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (updateId: string) => toggleUpdateLike(updateId, publicKey),
    onMutate: async (updateId) => {
      await queryClient.cancelQueries({ queryKey: ["updateLikes", updateId] });
      const previous = queryClient.getQueryData<LikeState>([
        "updateLikes",
        updateId,
      ]);

      queryClient.setQueryData<LikeState>(["updateLikes", updateId], (old) => {
        const liked = !old?.liked;
        const likeCount = old?.liked
          ? Math.max((old.likeCount || 0) - 1, 0)
          : (old?.likeCount || 0) + 1;
        return { liked, likeCount };
      });

      return { previous };
    },
    onError: (err, updateId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(["updateLikes", updateId], context.previous);
      }
      toast.error("Failed to update like. Please try again.");
      if (options?.onError) {
        options.onError(err);
      }
    },
    onSettled: (data, error, updateId) => {
      queryClient.invalidateQueries({ queryKey: ["updateLikes", updateId] });
    },
  });
}
