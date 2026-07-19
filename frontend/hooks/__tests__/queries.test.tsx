import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useProjectQuery,
  useFollowProject,
  useUnfollowProject,
  useToggleUpdateLike,
} from "../../hooks/queries";
import * as api from "../../lib/api";
import React from "react";

// Mock the API client functions
jest.mock("../../lib/api", () => ({
  followProject: jest.fn(),
  unfollowProject: jest.fn(),
  toggleUpdateLike: jest.fn(),
  fetchUpdateLikes: jest.fn(),
  fetchProject: jest.fn(),
}));

const mockProject = {
  id: "proj-123",
  name: "Ocean Cleanup",
  followCount: 5,
  isFollowing: false,
};

describe("queries hooks unit tests", () => {
  let queryClient: QueryClient;
  let wrapper: React.FC<{ children: React.ReactNode }>;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  });

  it("useProjectQuery returns project data", async () => {
    (api.fetchProject as jest.Mock).mockResolvedValue(mockProject);

    const { result } = renderHook(
      () => useProjectQuery("proj-123", undefined, "wallet-123"),
      { wrapper },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockProject);
  });

  it("useFollowProject optimistically updates follow count and state, and refetches on settle", async () => {
    // Seed query cache
    queryClient.setQueryData(["project", "proj-123"], mockProject);

    let resolveMutation: (val: any) => void = () => {};
    (api.followProject as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );

    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useFollowProject("wallet-123"), {
      wrapper,
    });

    result.current.mutate("proj-123");

    // Instantly verified optimistic update in cache
    await waitFor(() => {
      const cachedProject = queryClient.getQueryData<any>([
        "project",
        "proj-123",
      ]);
      expect(cachedProject.isFollowing).toBe(true);
      expect(cachedProject.followCount).toBe(6);
    });

    // Resolve API
    resolveMutation({ isFollowing: true, followCount: 6 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["project", "proj-123"] }),
    );
  });

  it("useFollowProject rolls back state and follow count on API failure", async () => {
    queryClient.setQueryData(["project", "proj-123"], mockProject);

    (api.followProject as jest.Mock).mockRejectedValue(new Error("API Error"));

    const { result } = renderHook(() => useFollowProject("wallet-123"), {
      wrapper,
    });

    result.current.mutate("proj-123");

    // Reverts to mockProject on error
    await waitFor(() => expect(result.current.isError).toBe(true));
    const cachedProject = queryClient.getQueryData<any>([
      "project",
      "proj-123",
    ]);
    expect(cachedProject.isFollowing).toBe(false);
    expect(cachedProject.followCount).toBe(5);
  });

  it("useUnfollowProject optimistically updates and refetches on settle", async () => {
    const followedProject = { ...mockProject, isFollowing: true, followCount: 6 };
    queryClient.setQueryData(["project", "proj-123"], followedProject);

    let resolveMutation: (val: any) => void = () => {};
    (api.unfollowProject as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );

    const { result } = renderHook(() => useUnfollowProject("wallet-123"), {
      wrapper,
    });

    result.current.mutate("proj-123");

    await waitFor(() => {
      const cachedProject = queryClient.getQueryData<any>([
        "project",
        "proj-123",
      ]);
      expect(cachedProject.isFollowing).toBe(false);
      expect(cachedProject.followCount).toBe(5);
    });

    resolveMutation({ isFollowing: false, followCount: 5 });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("useUnfollowProject rolls back on API failure", async () => {
    const followedProject = { ...mockProject, isFollowing: true, followCount: 6 };
    queryClient.setQueryData(["project", "proj-123"], followedProject);

    (api.unfollowProject as jest.Mock).mockRejectedValue(new Error("API Error"));

    const { result } = renderHook(() => useUnfollowProject("wallet-123"), {
      wrapper,
    });

    result.current.mutate("proj-123");

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cachedProject = queryClient.getQueryData<any>([
      "project",
      "proj-123",
    ]);
    expect(cachedProject.isFollowing).toBe(true);
    expect(cachedProject.followCount).toBe(6);
  });

  it("useToggleUpdateLike optimistically toggles like and updates count, and rolls back on failure", async () => {
    const initialLikeState = { liked: false, likeCount: 10 };
    queryClient.setQueryData(["updateLikes", "upd-456"], initialLikeState);

    let rejectMutation: (err: any) => void = () => {};
    (api.toggleUpdateLike as jest.Mock).mockReturnValue(
      new Promise((resolve, reject) => {
        rejectMutation = reject;
      }),
    );

    const { result } = renderHook(() => useToggleUpdateLike("wallet-123"), {
      wrapper,
    });

    result.current.mutate("upd-456");

    // Instantly verified optimistic toggle
    await waitFor(() => {
      const optimisticState = queryClient.getQueryData<any>([
        "updateLikes",
        "upd-456",
      ]);
      expect(optimisticState.liked).toBe(true);
      expect(optimisticState.likeCount).toBe(11);
    });

    // Reject the mutation to trigger API failure
    rejectMutation(new Error("API Error"));

    // Rollback triggers on mutation failure
    await waitFor(() => expect(result.current.isError).toBe(true));
    const rolledBackState = queryClient.getQueryData<any>([
      "updateLikes",
      "upd-456",
    ]);
    expect(rolledBackState.liked).toBe(false);
    expect(rolledBackState.likeCount).toBe(10);
  });
});
