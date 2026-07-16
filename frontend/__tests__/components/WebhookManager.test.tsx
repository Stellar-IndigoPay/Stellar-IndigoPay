/**
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import WebhookManager from "@/components/admin/WebhookManager";
import type { WebhookDelivery } from "@/lib/api";

const mockFetchDeadLetterWebhooks = jest.fn();
const mockReplayWebhookDelivery = jest.fn();
const mockReplayAllWebhookDeliveries = jest.fn();
const mockFetchWebhookDeliveries = jest.fn();

jest.mock("@/lib/api", () => ({
  fetchDeadLetterWebhooks: (...args: unknown[]) => mockFetchDeadLetterWebhooks(...args),
  replayWebhookDelivery: (...args: unknown[]) => mockReplayWebhookDelivery(...args),
  replayAllWebhookDeliveries: (...args: unknown[]) => mockReplayAllWebhookDeliveries(...args),
  fetchWebhookDeliveries: (...args: unknown[]) => mockFetchWebhookDeliveries(...args),
}));

const MOCK_DELIVERY: WebhookDelivery = {
  id: "delivery-1",
  projectId: "proj-1",
  projectName: "Amazon Reforestation",
  eventId: "evt-abc",
  eventType: "milestone.reached",
  status: "dlq",
  attempts: 6,
  lastAttemptAt: "2026-07-10T00:00:00.000Z",
  lastError: "timeout",
  nextAttemptAt: null,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-10T00:00:00.000Z",
};

describe("WebhookManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchDeadLetterWebhooks.mockResolvedValue({
      data: [MOCK_DELIVERY],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    mockFetchWebhookDeliveries.mockResolvedValue([MOCK_DELIVERY]);
  });

  test("loads and displays dead-lettered deliveries", async () => {
    render(<WebhookManager adminKey="test-admin-key" />);

    await waitFor(() => {
      expect(screen.getByText("Amazon Reforestation")).toBeTruthy();
    });
    expect(screen.getByText("milestone.reached")).toBeTruthy();
    expect(screen.getByText("timeout")).toBeTruthy();
    expect(mockFetchDeadLetterWebhooks).toHaveBeenCalledWith("test-admin-key", {
      projectId: undefined,
      limit: 20,
    });
  });

  test("shows the empty state when there are no dead-lettered deliveries", async () => {
    mockFetchDeadLetterWebhooks.mockResolvedValue({ data: [], total: 0, page: 1, pageSize: 20 });

    render(<WebhookManager adminKey="test-admin-key" />);

    await waitFor(() => {
      expect(screen.getByText("No dead-lettered webhook deliveries.")).toBeTruthy();
    });
  });

  test("replays a single delivery", async () => {
    mockReplayWebhookDelivery.mockResolvedValue({ ...MOCK_DELIVERY, status: "delivered" });

    render(<WebhookManager adminKey="test-admin-key" />);

    await waitFor(() => screen.getByText("Amazon Reforestation"));

    fireEvent.click(screen.getByRole("button", { name: "Replay" }));

    await waitFor(() => {
      expect(mockReplayWebhookDelivery).toHaveBeenCalledWith("delivery-1", "test-admin-key");
    });
    expect(mockFetchDeadLetterWebhooks).toHaveBeenCalledTimes(2); // initial load + reload after replay
  });

  test("replay-all requires a project ID filter", async () => {
    render(<WebhookManager adminKey="test-admin-key" />);

    await waitFor(() => screen.getByText("Amazon Reforestation"));

    fireEvent.click(screen.getByRole("button", { name: "Replay all for project" }));

    expect(mockReplayAllWebhookDeliveries).not.toHaveBeenCalled();
    expect(
      screen.getByText("Enter a project ID to replay all dead-lettered deliveries for it"),
    ).toBeTruthy();
  });

  test("replays all deliveries for a filtered project", async () => {
    mockReplayAllWebhookDeliveries.mockResolvedValue(3);

    render(<WebhookManager adminKey="test-admin-key" />);
    await waitFor(() => screen.getByText("Amazon Reforestation"));

    fireEvent.change(screen.getByPlaceholderText("Filter by project ID..."), {
      target: { value: "proj-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replay all for project" }));

    await waitFor(() => {
      expect(mockReplayAllWebhookDeliveries).toHaveBeenCalledWith("proj-1", "test-admin-key");
    });
  });

  test("toggles and loads delivery history", async () => {
    render(<WebhookManager adminKey="test-admin-key" />);
    await waitFor(() => screen.getByText("Amazon Reforestation"));

    fireEvent.click(screen.getByRole("button", { name: "Show delivery history" }));

    await waitFor(() => {
      expect(mockFetchWebhookDeliveries).toHaveBeenCalledWith("test-admin-key", {
        projectId: undefined,
        limit: 50,
      });
    });
    expect(screen.getByText("dlq")).toBeTruthy();
  });
});
