/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import AdminIndex from "@/pages/admin/index";

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), query: {}, pathname: "/admin" }),
}));

const mockConnect = jest.fn();
let mockPublicKey: string | null = null;
jest.mock("@/lib/WalletProvider", () => ({
  useWallet: () => ({ publicKey: mockPublicKey, connect: mockConnect }),
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

jest.mock("@/lib/api", () => ({
  fetchProjects: () => mockFetchProjects(),
  updateProjectStatus: jest.fn(),
  registerProjectOnChain: jest.fn(),
  confirmProjectRegistration: jest.fn(),
  fetchQueues: (adminKey: string) => mockFetchQueues(adminKey),
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

describe("AdminIndex - Queue Monitoring", () => {
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

  test("renders wallet connect when not connected", () => {
    mockPublicKey = null;
    render(<AdminIndex />);
    expect(screen.getByText("Connect your wallet to manage projects.")).toBeTruthy();
  });

  test("renders queue list and controls when connected", async () => {
    mockPublicKey = "GADMINPUBLICKEY";
    render(<AdminIndex />);

    // Wait for queue metrics to render
    await waitFor(() => {
      expect(screen.getByText("Queue Monitoring")).toBeTruthy();
      expect(screen.getByText("webhook-deliveries")).toBeTruthy();
    });

    // Check stats are rendered
    expect(screen.getByText("2")).toBeTruthy(); // Waiting count
    expect(screen.getByText("1")).toBeTruthy(); // Active count
    expect(screen.getByText("3")).toBeTruthy(); // Failed count
    expect(screen.getByText("4")).toBeTruthy(); // Completed count
    expect(screen.getByText("42.8%")).toBeTruthy(); // Failure rate

    // Test pause action
    const pauseBtn = screen.getByRole("button", { name: "Pause" });
    await act(async () => {
      fireEvent.click(pauseBtn);
    });
    expect(mockPauseQueue).toHaveBeenCalledWith("webhook-deliveries", "GADMINPUBLICKEY");

    // Wait for the pause operation to finish so the Purge button is
    // re-enabled (handlePauseQueue sets queuesLoading = true then
    // calls loadQueues which flips it back to false).
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Purge" })).not.toBeDisabled();
    });

    // Test purge action
    const originalConfirm = window.confirm;
    window.confirm = jest.fn().mockReturnValue(true);
    const purgeBtn = screen.getByRole("button", { name: "Purge" });
    await act(async () => {
      fireEvent.click(purgeBtn);
    });
    await waitFor(() =>
      expect(mockPurgeQueue).toHaveBeenCalledWith("webhook-deliveries", "GADMINPUBLICKEY"),
    );
    window.confirm = originalConfirm;
  });
});
