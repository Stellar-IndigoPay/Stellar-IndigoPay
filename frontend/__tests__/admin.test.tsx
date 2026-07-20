/**
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import AdminIndex from "@/pages/admin/index";

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), query: {}, pathname: "/admin" }),
}));

// Mock admin authentication
jest.mock("@/lib/adminAuth", () => ({
  ensureAdminSession: jest.fn().mockResolvedValue(true),
  adminLogout: jest.fn(),
  getAdminToken: jest.fn().mockReturnValue("mock-jwt-token"),
}));

const mockConnect = jest.fn();
let mockPublicKey: string | null = null;

jest.mock("@/lib/WalletProvider", () => ({
  useWallet: () => ({
    publicKey: mockPublicKey,
    connect: mockConnect,
  }),
}));
}));

const mockFetchProjects = jest.fn().mockResolvedValue([]);
const mockFetchQueues = jest.fn().mockResolvedValue([
  {
    queue: "webhook-deliveries",
    active: 1,
    waiting: 2,
    failed: 3,
    completed: 4,
    depth: 3,
    failure_rate: 0.428,
    latency: 1.5,
    paused: false,
  },
]);
const mockPauseQueue = jest.fn().mockResolvedValue(true);
const mockResumeQueue = jest.fn().mockResolvedValue(true);
const mockPurgeQueue = jest.fn().mockResolvedValue(true);
const mockFetchDeadLetterWebhooks = jest
  .fn()
  .mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
const mockFetchWebhookDeliveries = jest.fn().mockResolvedValue([]);
const mockFetchIndexerStatus = jest.fn().mockResolvedValue({
  active: true,
  lagLedgers: 0,
});
const mockFetchVerificationRequests = jest.fn().mockResolvedValue([]);

jest.mock("@/lib/api", () => ({
  fetchProjects: () => mockFetchProjects(),
  updateProjectStatus: jest.fn(),
  registerProjectOnChain: jest.fn(),
  confirmProjectRegistration: jest.fn(),
  fetchQueues: (adminKey: string) => mockFetchQueues(adminKey),
  fetchIndexerStatus: (adminKey: string) => mockFetchIndexerStatus(adminKey),
  fetchVerificationRequests: (params?: any) => mockFetchVerificationRequests(params),
  pauseQueue: (name: string, adminKey: string) => mockPauseQueue(name, adminKey),
  resumeQueue: (name: string, adminKey: string) => mockResumeQueue(name, adminKey),
  purgeQueue: (name: string, adminKey: string) => mockPurgeQueue(name, adminKey),
  fetchDeadLetterWebhooks: (...args: unknown[]) => mockFetchDeadLetterWebhooks(...args),
  replayWebhookDelivery: jest.fn(),
  replayAllWebhookDeliveries: jest.fn(),
  listAdminMatches: jest.fn().mockResolvedValue([]),
  createAdminMatch: jest.fn(),
  updateAdminMatch: jest.fn(),
  deleteAdminMatch: jest.fn(),
}));

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

describe("AdminIndex - Queue Monitoring & Health Dashboard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Re-apply resolved values cleared by clearAllMocks
    mockFetchProjects.mockResolvedValue([]);
    mockFetchQueues.mockResolvedValue([
      {
        queue: "webhook-deliveries",
        active: 1,
        waiting: 2,
        failed: 3,
        completed: 4,
        depth: 3,
        failure_rate: 0.428,
        latency: 1.5,
        paused: false,
      },
    ]);
    mockPauseQueue.mockResolvedValue(true);
    mockResumeQueue.mockResolvedValue(true);
    mockPurgeQueue.mockResolvedValue(true);
    mockFetchDeadLetterWebhooks.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });
    mockFetchWebhookDeliveries.mockResolvedValue([]);
  });

test("renders wallet connect when not connected", async () => {
  mockPublicKey = null;

  render(<AdminIndex />);

  await waitFor(() => {
    expect(
      screen.getByText(
        "Connect your administrator Stellar wallet to verify queue metrics, check background indexer health, and manage verifications."
      )
    ).toBeTruthy();
  });
});

test("renders queue health metrics and cards when connected", async () => {
  mockPublicKey = "GADMINPUBLICKEY";

  render(<AdminIndex />);

  // existing assertions for queue metrics/cards...
});

    // Wait for queue metrics to render
    await waitFor(() => {
      expect(screen.getByText("Queue Health")).toBeTruthy();
    });

    // Check stats are rendered from mock values: active=1, waiting=2, failed=3, completed=4
    expect(screen.getByText("2")).toBeTruthy(); // Waiting count
    expect(screen.getByText("1")).toBeTruthy(); // Active count
    expect(screen.getByText("3")).toBeTruthy(); // Failed count
    expect(screen.getByText("4")).toBeTruthy(); // Completed count
  });
});
