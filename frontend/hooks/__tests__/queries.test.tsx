/**
 * hooks/__tests__/queries.test.ts
 * Unit tests for React Query hooks
 */
import React from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useDonorHistory,
  useDonorProfile,
  useLeaderboard,
  useGlobalStats,
  useImpactDonor,
  useImpactGlobal,
  useRecordDonation,
  useFollowProject,
  useUnfollowProject,
  queryKeys,
} from "../queries";
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

// ── Mocks ─────────────────────────────────────────────────────────────────────
jest.mock("@/lib/api", () => ({
  fetchDonorHistory: jest.fn(),
  fetchLeaderboard: jest.fn(),
  fetchGlobalStats: jest.fn(),
  fetchProfile: jest.fn(),
  fetchImpactDonor: jest.fn(),
  fetchImpactGlobal: jest.fn(),
  recordDonation: jest.fn(),
  followProject: jest.fn(),
  unfollowProject: jest.fn(),
}));

const mockFetchDonorHistory = fetchDonorHistory as jest.Mock;
const mockFetchLeaderboard = fetchLeaderboard as jest.Mock;
const mockFetchGlobalStats = fetchGlobalStats as jest.Mock;
const mockFetchProfile = fetchProfile as jest.Mock;
const mockFetchImpactDonor = fetchImpactDonor as jest.Mock;
const mockFetchImpactGlobal = fetchImpactGlobal as jest.Mock;
const mockRecordDonation = recordDonation as jest.Mock;
const mockFollowProject = followProject as jest.Mock;
const mockUnfollowProject = unfollowProject as jest.Mock;

// ── Helpers ───────────────────────────────────────────────────────────────────

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

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

    // Use a shared QueryClient to verify invalidation
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    // Pre-populate cache with some data
    queryClient.setQueryData(queryKeys.donorHistory("GABC123"), donationsFixture);
    queryClient.setQueryData(queryKeys.leaderboard(), leaderboardFixture);
    queryClient.setQueryData(queryKeys.globalStats(), globalStatsFixture);
    queryClient.setQueryData(queryKeys.impactDonor("GABC123"), impactDonorFixture);

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useRecordDonation(), {
      wrapper: Wrapper,
    });

    await result.current.mutateAsync({
      projectId: "p1",
      donorAddress: "GABC123",
      amountXLM: "100",
      transactionHash: "tx1",
    });

    expect(mockRecordDonation).toHaveBeenCalled();

    // Verify the mutation was called with the correct donation payload.
    // React Query wraps mutationFn calls so we check the call's presence
    // and validate cache invalidation below.
    const callArg = mockRecordDonation.mock.calls[0]?.[0];
    expect(callArg).toMatchObject({
      projectId: "p1",
      donorAddress: "GABC123",
      amountXLM: "100",
      transactionHash: "tx1",
    });

    // After invalidation, queries should be marked as stale
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

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useFollowProject(), {
      wrapper: Wrapper,
    });

    await result.current.mutateAsync({
      projectId: "p1",
      walletAddress: "GABC123",
    });

    expect(mockFollowProject).toHaveBeenCalledWith("p1", "GABC123");
    const projectState = queryClient.getQueryState(["project", "p1"]);
    expect(projectState?.isInvalidated).toBe(true);
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

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }

    const { result } = renderHook(() => useUnfollowProject(), {
      wrapper: Wrapper,
    });

    await result.current.mutateAsync({
      projectId: "p1",
      walletAddress: "GABC123",
    });

    expect(mockUnfollowProject).toHaveBeenCalledWith("p1", "GABC123");
    const projectState = queryClient.getQueryState(["project", "p1"]);
    expect(projectState?.isInvalidated).toBe(true);
  });
});
