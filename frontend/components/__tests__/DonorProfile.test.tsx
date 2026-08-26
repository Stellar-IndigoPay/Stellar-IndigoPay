import React from "react";
import { render, act, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DonorProfilePage from "../../pages/donors/[publicKey]";
import { useRouter } from "next/router";
import { fetchProfile, fetchDonorHistory } from "@/lib/api";

jest.mock("next/router", () => ({
  useRouter: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  fetchProfile: jest.fn(),
  fetchDonorHistory: jest.fn(),
}));

const mockDonations = [
  {
    id: "1",
    projectId: "proj-1",
    donorAddress: "G1234567890123456789012345678901234567890123456789012345",
    amountXLM: "100",
    currency: "XLM",
    transactionHash: "hash",
    createdAt: "2023-01-01T00:00:00.000Z",
  },
];

describe("DonorProfile Component", () => {
  function makeClient() {
    return new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  }

  function Wrapper({
    client,
    children,
  }: {
    client: QueryClient;
    children: React.ReactNode;
  }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }

  beforeEach(() => {
    (useRouter as jest.Mock).mockReturnValue({
      query: {
        publicKey: "G1234567890123456789012345678901234567890123456789012345",
      },
    });
    (fetchDonorHistory as jest.Mock).mockResolvedValue(mockDonations);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const tiers = [
    { name: "None", badges: [] },
    {
      name: "Seedling",
      badges: [{ tier: "seedling", earnedAt: "2023-01-01T00:00:00.000Z" }],
    },
    {
      name: "Tree",
      badges: [{ tier: "tree", earnedAt: "2023-01-01T00:00:00.000Z" }],
    },
    {
      name: "Forest",
      badges: [{ tier: "forest", earnedAt: "2023-01-01T00:00:00.000Z" }],
    },
    {
      name: "EarthGuardian",
      badges: [{ tier: "earth", earnedAt: "2023-01-01T00:00:00.000Z" }],
    },
  ];

  it.each(tiers)(
    "matches snapshot for badge tier: $name",
    async ({ badges }) => {
      (fetchProfile as jest.Mock).mockResolvedValue({
        publicKey: "G1234567890123456789012345678901234567890123456789012345",
        displayName: "Test Donor",
        bio: "Test bio",
        totalDonatedXLM: "1000",
        projectsSupported: 5,
        badges,
        createdAt: "2023-01-01T00:00:00.000Z",
      });

      // A fresh QueryClient per case keeps each badge tier from reusing the
      // previous case's cached profile (the cache is keyed only on the
      // public key, so the shared client made every tier render tier #1's
      // data and flipped the skeleton/loaded snapshot under CI load).
      const client = makeClient();
      let component;
      await act(async () => {
        component = render(<DonorProfilePage />, {
          wrapper: ({ children }) => (
            <Wrapper client={client}>{children}</Wrapper>
          ),
        });
      });

      // The profile query resolves asynchronously (TanStack Query notifies
      // on a timer, so it never flushes inside the render act above); await
      // the loaded state before snapshotting. findBy* wraps itself in act,
      // so the re-render is flushed without an extra explicit act.
      await screen.findByText("Test Donor");

      expect(component!.container).toMatchSnapshot();
    },
  );
});
