Here is the complete, resolved unit test file for `hooks/__tests__/queries.test.ts` containing all test cases and fixtures from both branches:

```typescript
/**
 * hooks/__tests__/queries.test.ts
 * Unit tests for React Query hooks
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useProjectQuery,
  useDonorHistory,
  useDonorProfile,
  useLeaderboard,
  useGlobalStats,
  useImpactDonor,
  useImpactGlobal,
  useRecordDonation,
  useFollowProject,
  useUnfollowProject,
  useToggleUpdateLike,
  queryKeys,
} from "../queries";
import {
  fetchProject,
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
} from "@/lib/api";

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock("@/lib/api", () => ({
  fetchProject: jest.fn(),
  fetchDonorHistory: jest.fn(),
  fetchLeaderboard: jest.fn(),
  fetchGlobalStats: jest.fn(),
  fetchProfile: jest.fn(),
  fetchImpactDonor: jest.fn(),
  fetchImpactGlobal: jest.fn(),
  recordDonation: jest.fn(),
  followProject: jest.fn(),
  unfollowProject: jest.fn(),
  toggleUpdateLike: jest.fn(),
  fetchUpdateLikes: jest.fn(),
}));

const mockFetchProject = fetchProject as jest.Mock;
const mockFetchDonorHistory = fetchDonorHistory as jest.Mock;
const mockFetchLeaderboard = fetchLeaderboard as jest.Mock;
const mockFetchGlobalStats = fetchGlobalStats as jest.Mock;
const mockFetchProfile = fetchProfile as jest.Mock;
const mockFetchImpactDonor = fetchImpactDonor as jest.Mock;
const mockFetchImpactGlobal = fetchImpactGlobal as jest.Mock;
const mockRecordDonation = recordDonation as jest.Mock;
const mockFollowProject = followProject as jest.Mock;
const mockUnfollowProject = unfollowProject as jest.Mock;
const mockToggleUpdateLike = toggleUpdateLike as jest.Mock;
const mockFetchUpdateLikes = fetchUpdateLikes as jest.Mock;

// ── Helpers & Fixtures ────────────────────────────────────────────────────────

function createWrapper(customQueryClient?: QueryClient) {
  const queryClient =
    customQueryClient ??
    new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

const mockProject = {
  id: "proj-123",
  name: "Ocean Cleanup",
  followCount: 5,
  isFollowing: false,
};

const donationsFixture = [
  {
    id: "d1",
    projectId: "p1",
    donorAddress: "GABC123",
    amountXLM: "100",
    currency: "XLM" as const,
    transactionHash: "tx1",
    createdAt: "2025-01-15T00:00:00Z",
  },
];

const profileFixture = {
  publicKey: "GABC123",
  displayName: "Alice",
  totalDonatedXLM: "500",
  projectsSupported: 3,
  badges: [],
  createdAt: "2024-06-01T00:00:00Z",
};

const leaderboardFixture = [
  {
    rank: 1,
    publicKey: "GABC123",
    displayName: "Alice",
    totalDonatedXLM: "500",
    projectsSupported: 3,
  },
];

const globalStatsFixture = {
  totalXLMRaised: "10000",
  totalCO2OffsetKg: 5000,
  totalDonations: 200,
  totalProjects: 50,
  totalDonors: 100,
};

const impactDonorFixture = {
  totalDonatedXLM: "500",
  co2OffsetKg: 250,
  projectsSupported: 3,
  topCategory: "Reforestation",
};

const impactGlobalFixture = {
  totalDonationsXLM: "10000",
  donorCount: 100,
  co2OffsetKg: 5000,
  treesEquivalent: 250,
  uniqueCountries: 15,
  breakdownByCategory: [],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("useProjectQuery", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns project data", async () => {
    mockFetchProject.mockResolvedValue(mockProject);

    const { result } = renderHook(
      () => useProjectQuery("proj-123", undefined, "wallet-123"),
      { wrapper: createWrapper() },
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockProject);
  });
});

describe("useDonorHistory", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns loading state initially when publicKey is provided", () => {
    mockFetchDonorHistory.mockResolvedValue(donationsFixture);
    const { result } = renderHook(() => useDonorHistory("GABC123"), {
      wrapper: createWrapper(),
    });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeUndefined();
  });

  it("returns data after successful fetch", async () => {
    mockFetchDonorHistory.mockResolvedValue(donationsFixture);
    const { result } = renderHook(() => useDonorHistory("GABC123"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(donationsFixture);
    expect(mockFetchDonorHistory).toHaveBeenCalledWith("GABC123");
  });

  it("is disabled when publicKey is null", () => {
    mockFetchDonorHistory.mockResolvedValue(donationsFixture);
    const { result } = renderHook(() => useDonorHistory(null), {
      wrapper: createWrapper(),
    });
    expect(result.current.isLoading).toBe(false);
    expect(mockFetchDonorHistory).not.toHaveBeenCalled();
  });

  it("returns error state on fetch failure", async () => {
    const testError = new Error("Network error");
    mockFetchDonorHistory.mockRejectedValue(testError);
    const { result } = renderHook(() => useDonorHistory("GABC123"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeDefined();
  });
});

describe("useDonorProfile", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns data after successful fetch", async () => {
    mockFetchProfile.mockResolvedValue(profileFixture);
    const { result } = renderHook(() => useDonorProfile("GABC123"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(profileFixture);
    expect(mockFetchProfile).toHaveBeenCalledWith("GABC123");
  });

  it("is disabled when publicKey is null", () => {
    const { result } = renderHook(() => useDonorProfile(null), {
      wrapper: createWrapper(),
    });
    expect(result.current.isLoading).toBe(false);
    expect(mockFetchProfile).not.toHaveBeenCalled();
  });
});

describe("useLeaderboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns data after successful fetch", async () => {
    mockFetchLeaderboard.mockResolvedValue(leaderboardFixture);
    const { result } = renderHook(() => useLeaderboard(20, "all"), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(leaderboardFixture);
    expect(mockFetchLeaderboard).toHaveBeenCalledWith(20, "all");
  });

  it("defaults to limit=20 and no period", async () => {
    mockFetchLeaderboard.mockResolvedValue(leaderboardFixture);
    const { result } = renderHook(() => useLeaderboard(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockFetchLeaderboard).toHaveBeenCalledWith(20, undefined);
  });
});

describe("useGlobalStats", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns data after successful fetch", async () => {
    mockFetchGlobalStats.mockResolvedValue(globalStatsFixture);
    const { result } = renderHook(() => useGlobalStats(), {
      wrapper: createWrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(globalStatsFixture);
  });
});

describe("useRecordDonation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls recordDonation and invalidates related queries on success", async () => {
    mockRecordDonation.mockResolvedValue({ id: "d1" });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    queryClient.setQueryData(queryKeys.donorHistory("GABC123"), donationsFixture);
    queryClient.setQueryData(queryKeys.leaderboard(), leaderboardFixture);
    queryClient.setQueryData(queryKeys.globalStats(), globalStatsFixture);
    queryClient.setQueryData(queryKeys.impactDonor("GABC123"), impactDonorFixture);

    const { result } = renderHook(() => useRecordDonation(), {
      wrapper: createWrapper(queryClient),
    });

    await result.current.mutateAsync({
      projectId: "p1",
      donorAddress: "GABC123",
      amountXLM: "100",
      transactionHash: "tx1",
    });

    expect(mockRecordDonation).toHaveBeenCalled();

    const callArg = mockRecordDonation.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      projectId: "p1",
      donorAddress: "GABC123",
      amountXLM: "100",
      transactionHash: "tx1",
    });

    const donorHistoryState = queryClient.getQueryState(
      queryKeys.donorHistory("GABC123"),
    );
    const leaderboardState = queryClient.getQueryState(queryKeys.leaderboard());
    const globalStatsState = queryClient.getQueryState(queryKeys.globalStats());

    expect(donorHistoryState?.isInvalidated).toBe(true);
    expect(leaderboardState?.isInvalidated).toBe(true);
    expect(globalStatsState?.isInvalidated).toBe(true);
  });
});

describe("useFollowProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls followProject and invalidates project query on success", async () => {
    mockFollowProject.mockResolvedValue({ isFollowing: true, followCount: 5 });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["project", "p1"], { id: "p1" });

    const { result } = renderHook(() => useFollowProject(), {
      wrapper: createWrapper(queryClient),
    });

    await result.current.mutateAsync({
      projectId: "p1",
      walletAddress: "GABC123",
    });

    expect(mockFollowProject).toHaveBeenCalledWith("p1", "GABC123");
    const projectState = queryClient.getQueryState(["project", "p1"]);
    expect(projectState?.isInvalidated).toBe(true);
  });

  it("optimistically updates follow count and state, and refetches on settle", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["project", "proj-123"], mockProject);

    let resolveMutation: (val: any) => void = () => {};
    mockFollowProject.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );

    const invalidateSpy = jest.spyOn(queryClient, "invalidateQueries");

    const { result } = renderHook(() => useFollowProject("wallet-123"), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate("proj-123");

    await waitFor(() => {
      const cachedProject = queryClient.getQueryData<any>([
        "project",
        "proj-123",
      ]);
      expect(cachedProject.isFollowing).toBe(true);
      expect(cachedProject.followCount).toBe(6);
    });

    resolveMutation({ isFollowing: true, followCount: 6 });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["project", "proj-123"] }),
    );
  });

  it("rolls back state and follow count on API failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(["project", "proj-123"], mockProject);

    mockFollowProject.mockRejectedValue(new Error("API Error"));

    const { result } = renderHook(() => useFollowProject("wallet-123"), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate("proj-123");

    await waitFor(() => expect(result.current.isError).toBe(true));
    const cachedProject = queryClient.getQueryData<any>([
      "project",
      "proj-123",
    ]);
    expect(cachedProject.isFollowing).toBe(false);
    expect(cachedProject.followCount).toBe(5);
  });
});

describe("useUnfollowProject", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("calls unfollowProject and invalidates project query on success", async () => {
    mockUnfollowProject.mockResolvedValue({ isFollowing: false, followCount: 4 });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    queryClient.setQueryData(["project", "p1"], { id: "p1" });

    const { result } = renderHook(() => useUnfollowProject(), {
      wrapper: createWrapper(queryClient),
    });

    await result.current.mutateAsync({
      projectId: "p1",
      walletAddress: "GABC123",
    });

    expect(mockUnfollowProject).toHaveBeenCalledWith("p1", "GABC123");
    const projectState = queryClient.getQueryState(["project", "p1"]);
    expect(projectState?.isInvalidated).toBe(true);
  });

  it("optimistically updates and refetches on settle", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const followedProject = { ...mockProject, isFollowing: true, followCount: 6 };
    queryClient.setQueryData(["project", "proj-123"], followedProject);

    let resolveMutation: (val: any) => void = () => {};
    mockUnfollowProject.mockReturnValue(
      new Promise((resolve) => {
        resolveMutation = resolve;
      }),
    );

    const { result } = renderHook(() => useUnfollowProject("wallet-123"), {
      wrapper: createWrapper(queryClient),
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

  it("rolls back on API failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const followedProject = { ...mockProject, isFollowing: true, followCount: 6 };
    queryClient.setQueryData(["project", "proj-123"], followedProject);

    mockUnfollowProject.mockRejectedValue(new Error("API Error"));

    const { result } = renderHook(() => useUnfollowProject("wallet-123"), {
      wrapper: createWrapper(queryClient),
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
});

describe("useToggleUpdateLike", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("optimistically toggles like and updates count, and rolls back on failure", async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });
    const initialLikeState = { liked: false, likeCount: 10 };
    queryClient.setQueryData(["updateLikes", "upd-456"], initialLikeState);

    let rejectMutation: (err: any) => void = () => {};
    mockToggleUpdateLike.mockReturnValue(
      new Promise((resolve, reject) => {
        rejectMutation = reject;
      }),
    );

    const { result } = renderHook(() => useToggleUpdateLike("wallet-123"), {
      wrapper: createWrapper(queryClient),
    });

    result.current.mutate("upd-456");

    await waitFor(() => {
      const optimisticState = queryClient.getQueryData<any>([
        "updateLikes",
        "upd-456",
      ]);
      expect(optimisticState.liked).toBe(true);
      expect(optimisticState.likeCount).toBe(11);
    });

    rejectMutation(new Error("API Error"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    const rolledBackState = queryClient.getQueryData<any>([
      "updateLikes",
      "upd-456",
    ]);
    expect(rolledBackState.liked).toBe(false);
    expect(rolledBackState.likeCount).toBe(10);
  });
});
```
  });
});
