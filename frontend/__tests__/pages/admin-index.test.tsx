/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminIndex from "@/pages/admin/index";

// Mock router
jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), query: {}, pathname: "/admin" }),
}));

// Mock admin authentication
jest.mock("@/lib/adminAuth", () => ({
  ensureAdminSession: jest.fn().mockResolvedValue(true),
  adminLogout: jest.fn(),
  getAdminToken: jest.fn().mockReturnValue("mock-jwt-token"),
}));

// Setup API mocks
const mockFetchQueues = jest.fn();
const mockFetchIndexerStatus = jest.fn();
const mockFetchVerificationRequests = jest.fn();

jest.mock("@/lib/api", () => ({
  fetchQueues: (adminKey: string) => mockFetchQueues(adminKey),
  fetchIndexerStatus: (adminKey: string) => mockFetchIndexerStatus(adminKey),
  fetchVerificationRequests: (params?: any) => mockFetchVerificationRequests(params),
}));

// Helper to wrap with QueryClient
const renderWithClient = (ui: React.ReactElement) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      {ui}
    </QueryClientProvider>
  );
};

describe("AdminIndex - Premium Dashboard Page Integration Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("1. Renders wallet connect screen when wallet is not connected", async () => {
    renderWithClient(<AdminIndex publicKey={null} onConnect={jest.fn()} />);

    // AdminLayout is rendering, check that check auth is completed and wallet connect screen is shown
    await waitFor(() => {
      expect(screen.getByText("Connect your administrator Stellar wallet to verify queue metrics, check background indexer health, and manage verifications.")).toBeTruthy();
    });
  });

  test("2. Renders loading skeletons when data is fetching", async () => {
    // Return unresolved promises to force loading state
    mockFetchQueues.mockReturnValue(new Promise(() => {}));
    mockFetchIndexerStatus.mockReturnValue(new Promise(() => {}));
    mockFetchVerificationRequests.mockReturnValue(new Promise(() => {}));

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    // Wait for the auth check inside AdminLayout to finish and show loading state
    await waitFor(() => {
      expect(screen.getByText("System Overview")).toBeTruthy();
    });

    // Skeletons are visible
    expect(screen.getAllByTestId("verification-skeleton").length).toBeGreaterThan(0);
  });

  test("3. Renders queue health cards correctly with combined totals across queues", async () => {
    mockFetchQueues.mockResolvedValue([
      { queue: "queues-1", active: 2, waiting: 5, failed: 1, completed: 10 },
      { queue: "queues-2", active: 3, waiting: 2, failed: 0, completed: 15 },
    ]);
    mockFetchIndexerStatus.mockResolvedValue({
      active: true,
      lagLedgers: 4,
    });
    mockFetchVerificationRequests.mockResolvedValue([]);

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Queue Health")).toBeTruthy();
    });

    // Check aggregated metrics in cards:
    // Active: 2 + 3 = 5
    // Waiting: 5 + 2 = 7
    // Failed: 1 + 0 = 1
    // Completed: 10 + 15 = 25
    expect(screen.getByText("5")).toBeTruthy(); // Active Jobs
    expect(screen.getByText("7")).toBeTruthy(); // Waiting Jobs
    expect(screen.getByText("1")).toBeTruthy(); // Failed Jobs
    expect(screen.getByText("25")).toBeTruthy(); // Completed Jobs
  });

  test("4. Displays indexer status and sequence lag correctly", async () => {
    mockFetchQueues.mockResolvedValue([]);
    mockFetchIndexerStatus.mockResolvedValue({
      active: true,
      lagLedgers: 12,
    });
    mockFetchVerificationRequests.mockResolvedValue([]);

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Indexer Status")).toBeTruthy();
    });

    expect(screen.getByText("Lag: 12 ledgers")).toBeTruthy();
    expect(screen.getByText("Status: Connected & Listening")).toBeTruthy();
  });

  test("5. Displays top 5 pending verification requests with review links", async () => {
    const mockRequests = [
      {
        id: "req-1",
        organizationName: "EcoForest",
        projectName: "Redwood Planting",
        projectCategory: "Reforestation",
        projectLocation: "California",
        status: "pending",
        submittedAt: "2026-07-17T00:00:00Z",
      },
      {
        id: "req-2",
        organizationName: "SolarPower Org",
        projectName: "Sahara Solar Farm",
        projectCategory: "Solar Energy",
        projectLocation: "Morocco",
        status: "pending",
        submittedAt: "2026-07-17T01:00:00Z",
      },
    ];

    mockFetchQueues.mockResolvedValue([]);
    mockFetchIndexerStatus.mockResolvedValue({ active: false, lagLedgers: null });
    mockFetchVerificationRequests.mockResolvedValue(mockRequests);

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Pending Verifications")).toBeTruthy();
    });

    expect(screen.getByText("EcoForest")).toBeTruthy();
    expect(screen.getByText("SolarPower Org")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Review" }).length).toBe(2);
  });

  test("6. Handles empty state for pending verification requests", async () => {
    mockFetchQueues.mockResolvedValue([]);
    mockFetchIndexerStatus.mockResolvedValue({ active: false, lagLedgers: null });
    mockFetchVerificationRequests.mockResolvedValue([]);

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No Pending Verifications")).toBeTruthy();
      expect(screen.getByText("Organizations are all caught up!")).toBeTruthy();
    });
  });

  test("7. Displays quick action links", async () => {
    mockFetchQueues.mockResolvedValue([]);
    mockFetchIndexerStatus.mockResolvedValue({ active: false, lagLedgers: null });
    mockFetchVerificationRequests.mockResolvedValue([]);

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Quick Actions")).toBeTruthy();
    });

    expect(screen.getByText("Review Verifications")).toBeTruthy();
    expect(screen.getByText("View Queues")).toBeTruthy();
    expect(screen.getAllByText("CO₂ Flags").length).toBeGreaterThan(0);
    expect(screen.getByText("Analytics")).toBeTruthy();
    expect(screen.getByText("Webhook DLQ")).toBeTruthy();
    expect(screen.getAllByText("Audit Log").length).toBeGreaterThan(0);
  });

  test("8. Handles API loading errors and triggers retry correctly", async () => {
    mockFetchQueues.mockRejectedValue(new Error("Network Failure"));
    mockFetchIndexerStatus.mockResolvedValue({ active: false, lagLedgers: null });
    mockFetchVerificationRequests.mockResolvedValue([]);

    renderWithClient(<AdminIndex publicKey="GADMINWALLET" onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Failed to load queue metrics: Network Failure")).toBeTruthy();
    });

    // Click retry
    mockFetchQueues.mockResolvedValue([
      { queue: "q", active: 1, waiting: 0, failed: 0, completed: 0 },
    ]);
    
    const retryBtn = screen.getByRole("button", { name: "Retry" });
    await act(async () => {
      fireEvent.click(retryBtn);
    });

    await waitFor(() => {
      expect(screen.getByText("1")).toBeTruthy(); // Shows updated value
      expect(screen.queryByText("Failed to load queue metrics: Network Failure")).toBeNull();
    });
  });
});
