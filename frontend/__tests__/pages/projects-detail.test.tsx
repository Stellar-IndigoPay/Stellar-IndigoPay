import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ProjectDetail from "../../pages/projects/[id]";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as api from "../../lib/api";
import React from "react";

// Mock router
jest.mock("next/router", () => ({
  useRouter: () => ({
    query: { id: "proj-123" },
    pathname: "/projects/[id]",
    push: jest.fn(),
  }),
}));

// Mock API
jest.mock("../../lib/api", () => ({
  fetchProjectUpdates: jest.fn(),
  fetchProjectMatches: jest.fn(),
  fetchSubscriberCount: jest.fn(),
  fetchUpdateLikes: jest.fn(),
  followProject: jest.fn(),
  unfollowProject: jest.fn(),
  toggleUpdateLike: jest.fn(),
  fetchProject: jest.fn(),
  fetchProjectDonations: jest
    .fn()
    .mockResolvedValue({ donations: [], nextCursor: null }),
}));

// Mock Stellar helper functions
jest.mock("@/lib/stellar", () => ({
  ...jest.requireActual("@/lib/stellar"),
  fetchProjectDiscussion: jest.fn().mockResolvedValue([]),
}));

const mockProject = {
  id: "proj-123",
  name: "Save the Forest",
  description: "Reforesting the Amazon.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "G123456",
  goalXLM: "1000",
  raisedXLM: "100",
  donorCount: 2,
  co2OffsetKg: 50,
  status: "active",
  verified: true,
  tags: [],
  isFollowing: false,
  followCount: 1,
};

const mockUpdates = [
  {
    id: "update-1",
    projectId: "proj-123",
    title: "Trees planted",
    body: "We planted 100 trees today!",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
];

describe("ProjectDetail page integration tests", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: Infinity },
        mutations: { retry: false },
      },
    });

    (api.fetchProject as jest.Mock).mockResolvedValue(mockProject);
    (api.fetchProjectUpdates as jest.Mock).mockResolvedValue(mockUpdates);
    (api.fetchProjectMatches as jest.Mock).mockResolvedValue([]);
    (api.fetchSubscriberCount as jest.Mock).mockResolvedValue(5);
    (api.fetchUpdateLikes as jest.Mock).mockResolvedValue({
      liked: false,
      likeCount: 2,
    });
  });

  const renderWithQueryClient = (ui: React.ReactElement) => {
    return render(
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    );
  };

  it("renders detail page, instantly toggles follow state, and rolls back on error", async () => {
    let resolveFollowPromise: (value: any) => void = () => {};
    (api.followProject as jest.Mock).mockReturnValue(
      new Promise((resolve, reject) => {
        resolveFollowPromise = reject; // simulate error for rollback test
      }),
    );

    renderWithQueryClient(
      <ProjectDetail
        publicKey="G_USER_WALLET"
        onConnect={jest.fn()}
        ogProject={null}
      />,
    );

    // Wait for initial load
    const followButton = await screen.findByRole("button", {
      name: "Follow (1)",
    });
    expect(followButton).toBeInTheDocument();

    // Click Follow
    fireEvent.click(followButton);

    // Instantly updates to "Following" and count 2 optimistically
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "✓ Following (2)" }),
      ).toBeInTheDocument();
    });

    // Trigger API error rejection
    resolveFollowPromise(new Error("API Error"));

    // Rolls back to original state on failure
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Follow (1)" }),
      ).toBeInTheDocument();
    });

    // Displays an error toast
    expect(
      screen.getByText("Failed to follow project. Please try again."),
    ).toBeInTheDocument();
  });

  it("instantly toggles update like status, and handles concurrent click guards", async () => {
    let resolveLikePromise: (value: any) => void = () => {};
    (api.toggleUpdateLike as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        resolveLikePromise = resolve;
      }),
    );

    renderWithQueryClient(
      <ProjectDetail
        publicKey="G_USER_WALLET"
        onConnect={jest.fn()}
        ogProject={null}
      />,
    );

    // Wait for update like button to render
    const likeButton = await screen.findByRole("button", { name: /🤍/ });
    expect(likeButton).toHaveTextContent("🤍2");

    // Click Like
    fireEvent.click(likeButton);

    // Instantly toggles heart and count optimistically
    await waitFor(() => {
      expect(likeButton).toHaveTextContent("❤️3");
    });

    // Click again immediately - should be guarded/ignored
    fireEvent.click(likeButton);

    // Ensure API is only called once due to pending mutation guard
    expect(api.toggleUpdateLike).toHaveBeenCalledTimes(1);

    // Settle mutation
    resolveLikePromise({ liked: true, likeCount: 3 });

    await waitFor(() => {
      expect(likeButton).toHaveTextContent("❤️3");
    });
  });

  it("renders correctly even when walletAddress is missing to prevent runtime crash", async () => {
    (api.fetchProject as jest.Mock).mockResolvedValue({
      id: "proj-123",
      name: "Ocean Cleanup",
      // walletAddress, description are missing/undefined
      goalXLM: "1000",
      raisedXLM: "100",
      donorCount: 2,
      status: "active",
      verified: true,
      tags: [],
      isFollowing: false,
      followCount: 1,
    });

    renderWithQueryClient(
      <ProjectDetail
        publicKey="G_USER_WALLET"
        onConnect={jest.fn()}
        ogProject={null}
      />,
    );

    expect(await screen.findByText("Ocean Cleanup")).toBeInTheDocument();
    expect(screen.getByText("No wallet address")).toBeInTheDocument();
  });

  it("renders Unknown for discussion messages with missing from address", async () => {
    (api.fetchProject as jest.Mock).mockResolvedValue({
      id: "proj-123",
      name: "Ocean Cleanup",
      walletAddress: "G_PROJECT_WALLET",
      goalXLM: "1000",
      raisedXLM: "100",
      donorCount: 2,
      status: "active",
      verified: true,
      tags: [],
      isFollowing: false,
      followCount: 1,
    });

    (api.fetchProjectDonations as jest.Mock).mockResolvedValue({
      donations: [
        {
          id: "don-1",
          amount: "50",
          // donorAddress is missing/undefined
          createdAt: new Date().toISOString(),
        },
      ],
      nextCursor: null,
    });

    const stellar = require("@/lib/stellar");
    (stellar.fetchProjectDiscussion as jest.Mock).mockResolvedValue([
      {
        id: "disc-1",
        amount: "10",
        createdAt: new Date().toISOString(),
        // from address is missing/undefined
      },
    ]);

    renderWithQueryClient(
      <ProjectDetail
        publicKey="G_USER_WALLET"
        onConnect={jest.fn()}
        ogProject={null}
      />,
    );

    expect(await screen.findByText("Ocean Cleanup")).toBeInTheDocument();
    expect(await screen.findByText("Unknown")).toBeInTheDocument();
  });
});
