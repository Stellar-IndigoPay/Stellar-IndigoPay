/**
 * @jest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import ProjectDetail from "@/pages/projects/[id]";
import type { ClimateProject } from "@/utils/types";

// Mock next/router
const mockPush = jest.fn();
jest.mock("next/router", () => ({
  useRouter: () => ({
    query: { id: "test-project-id" },
    pathname: "/projects/[id]",
    asPath: "/projects/test-project-id",
    push: mockPush,
  }),
}));

// Mock API functions
const mockFetchProject = jest.fn();
const mockFetchProjectUpdates = jest.fn();
const mockFetchProjectMatches = jest.fn();

jest.mock("@/lib/api", () => ({
  ...jest.requireActual("@/lib/api"),
  fetchProject: (...args: unknown[]) => mockFetchProject(...args),
  fetchProjectUpdates: (...args: unknown[]) => mockFetchProjectUpdates(...args),
  fetchProjectMatches: (...args: unknown[]) => mockFetchProjectMatches(...args),
}));

// Mock WalletProvider
jest.mock("@/lib/WalletProvider", () => ({
  useWallet: () => ({
    publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    connect: jest.fn(),
  }),
}));

const MOCK_PROJECT: ClimateProject = {
  id: "test-project-id",
  name: "Amazon Conservation",
  description: "Protecting the rainforest.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  goalXLM: "10000",
  raisedXLM: "2500",
  donorCount: 42,
  co2OffsetKg: 1200,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: ["forest"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("Active Matches Banner in Project Detail Page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProject.mockResolvedValue(MOCK_PROJECT);
    mockFetchProjectUpdates.mockResolvedValue([]);
  });

  test("renders active matches banner when active matches exist", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const mockMatches = [
      {
        id: "match-1",
        projectId: "test-project-id",
        matcherAddress: "GMATCH1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        capXLM: "5000.0000000",
        multiplier: 2,
        matchedXLM: "1000.0000000",
        remainingXLM: "4000.0000000",
        expiresAt: futureDate,
        createdAt: new Date().toISOString(),
        status: "active",
      },
    ];
    mockFetchProjectMatches.mockResolvedValue(mockMatches);

    render(<ProjectDetail />);

    // Wait for async load to finish and state to update
    await waitFor(() => {
      expect(screen.queryByText(/Donation Matching Active/i)).toBeTruthy();
    });

    expect(screen.getByText(/matched 2× up to 5,000 XLM/i)).toBeTruthy();
    expect(screen.getByText(/4,000 XLM remaining/i)).toBeTruthy();
  });

  test("does not render banner when no matches exist", async () => {
    mockFetchProjectMatches.mockResolvedValue([]);

    render(<ProjectDetail />);

    await waitFor(() => {
      expect(screen.queryByText(/Amazon Conservation/i)).toBeTruthy();
    });

    expect(screen.queryByText(/Donation Matching Active/i)).toBeNull();
  });

  test("does not render banner when match has expired", async () => {
    const pastDate = new Date(Date.now() - 10000).toISOString();
    const mockMatches = [
      {
        id: "match-1",
        projectId: "test-project-id",
        matcherAddress: "GMATCH1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        capXLM: "5000.0000000",
        multiplier: 2,
        matchedXLM: "1000.0000000",
        remainingXLM: "4000.0000000",
        expiresAt: pastDate,
        createdAt: new Date().toISOString(),
        status: "active",
      },
    ];
    mockFetchProjectMatches.mockResolvedValue(mockMatches);

    render(<ProjectDetail />);

    await waitFor(() => {
      expect(screen.queryByText(/Amazon Conservation/i)).toBeTruthy();
    });

    expect(screen.queryByText(/Donation Matching Active/i)).toBeNull();
  });

  test("does not render banner when match is exhausted", async () => {
    const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const mockMatches = [
      {
        id: "match-1",
        projectId: "test-project-id",
        matcherAddress: "GMATCH1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        capXLM: "1000.0000000",
        multiplier: 2,
        matchedXLM: "1000.0000000",
        remainingXLM: "0.0000000",
        expiresAt: futureDate,
        createdAt: new Date().toISOString(),
        status: "active",
      },
    ];
    mockFetchProjectMatches.mockResolvedValue(mockMatches);

    render(<ProjectDetail />);

    await waitFor(() => {
      expect(screen.queryByText(/Amazon Conservation/i)).toBeTruthy();
    });

    expect(screen.queryByText(/Donation Matching Active/i)).toBeNull();
  });
});
