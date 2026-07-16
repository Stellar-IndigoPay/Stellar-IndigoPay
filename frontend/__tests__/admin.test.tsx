/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import AdminIndex from "@/pages/admin/index";

jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), query: {}, pathname: "/admin" }),
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
  fetchWebhookDeliveries: (...args: unknown[]) => mockFetchWebhookDeliveries(...args),
}));

describe("AdminIndex - Queue Monitoring", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders wallet connect when not connected", () => {
    render(<AdminIndex publicKey={null} onConnect={jest.fn()} />);
    expect(screen.getByText("Connect your wallet to manage projects.")).toBeTruthy();
  });

  test("renders queue list and controls when connected", async () => {
    render(<AdminIndex publicKey="GADMINPUBLICKEY" onConnect={jest.fn()} />);

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
    fireEvent.click(pauseBtn);
    expect(mockPauseQueue).toHaveBeenCalledWith("webhook-deliveries", "GADMINPUBLICKEY");

    // Test purge action
    const originalConfirm = window.confirm;
    window.confirm = jest.fn().mockReturnValue(true);
    const purgeBtn = screen.getByRole("button", { name: "Purge" });
    fireEvent.click(purgeBtn);
    expect(mockPurgeQueue).toHaveBeenCalledWith("webhook-deliveries", "GADMINPUBLICKEY");
    window.confirm = originalConfirm;
  });
});
