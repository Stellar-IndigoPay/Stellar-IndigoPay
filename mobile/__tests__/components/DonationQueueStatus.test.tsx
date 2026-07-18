/**
 * __tests__/components/DonationQueueStatus.test.tsx
 *
 * Component tests for the offline donation queue status UI.
 *
 * Verifies:
 *   - pending/syncing/failed counts are displayed
 *   - failed items expose a Retry action
 *   - completed items can be dismissed
 */
import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  useLocalSearchParams: () => ({}),
}));
jest.mock("expo-status-bar", () => ({ StatusBar: () => null }));

jest.mock("../../utils/donationQueueWorker", () => ({
  retryAllNow: jest.fn().mockResolvedValue({ submitted: 0, failed: 0 }),
  retryDonationNow: jest.fn().mockResolvedValue(undefined),
  isSyncing: jest.fn(() => false),
  startQueueWorker: jest.fn(),
  stopQueueWorker: jest.fn(),
}));

jest.mock("../../utils/donationQueue");

import DonationQueueStatus from "../../components/DonationQueueStatus";
import { ThemeProvider } from "../../app/theme";
import {
  getQueuedDonations,
  getPendingCount,
  removeDonation,
} from "../../utils/donationQueue";

const failedDonation = {
  id: "dq_failed",
  projectId: "p1",
  projectName: "Amazon Reforestation",
  amount: "10.0000000",
  currency: "XLM" as const,
  donorAddress: "G",
  status: "failed" as const,
  attempts: 6,
  maxAttempts: 6,
  nextRetryAt: 0,
  retryable: false,
  lastError: "Project not found",
  errorCode: "PROJECT_NOT_FOUND",
  createdAt: 1,
  updatedAt: 2,
};

const pendingDonation = {
  ...failedDonation,
  id: "dq_pending",
  status: "pending" as const,
  retryable: true,
  lastError: undefined,
  errorCode: undefined,
};

beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.clear as jest.Mock)();
  // Reset the worker's isSyncing mock default so per-test overrides don't leak.
  const worker = require("../../utils/donationQueueWorker");
  worker.isSyncing.mockReturnValue(false);
});

function renderComponent() {
  return render(
    <ThemeProvider>
      <DonationQueueStatus />
    </ThemeProvider>,
  );
}

describe("DonationQueueStatus", () => {
  test("shows pending + failed counts and a Retry button for failed items", async () => {
    (getPendingCount as jest.Mock).mockResolvedValue(1);
    (getQueuedDonations as jest.Mock).mockResolvedValue([
      pendingDonation,
      failedDonation,
    ]);

    const { getByText, queryByText } = renderComponent();

    // Open the sheet (wait for the badge to populate)
    await waitFor(() => {
      expect(getByText("Pending")).toBeTruthy();
    });
    fireEvent.press(getByText("Pending"));

    await waitFor(() => {
      expect(getByText("Donation Queue")).toBeTruthy();
    });

    // Failed item shows the error and a Retry action
    expect(getByText("Project not found")).toBeTruthy();
    const retryBtn = getByText("Retry");
    expect(retryBtn).toBeTruthy();

    // Tapping Retry triggers the worker
    fireEvent.press(retryBtn);
    await waitFor(() => {
      expect(
        require("../../utils/donationQueueWorker").retryDonationNow,
      ).toHaveBeenCalledWith("dq_failed");
    });
  });

  test("shows a syncing badge instead of pending count while syncing", async () => {
    const worker = require("../../utils/donationQueueWorker");
    worker.isSyncing.mockReturnValue(true);
    (getPendingCount as jest.Mock).mockResolvedValue(2);

    const { getByText } = renderComponent();
    await waitFor(() => {
      expect(getByText("Syncing")).toBeTruthy();
    });
  });

  test("dismiss removes a failed donation", async () => {
    (getPendingCount as jest.Mock).mockResolvedValue(1);
    (getQueuedDonations as jest.Mock).mockResolvedValue([failedDonation]);

    const { getByText } = renderComponent();
    await waitFor(() => {
      expect(getByText("Pending")).toBeTruthy();
    });
    fireEvent.press(getByText("Pending"));

    await waitFor(() => {
      expect(getByText("Donation Queue")).toBeTruthy();
    });

    fireEvent.press(getByText("Dismiss"));
    await waitFor(() => {
      expect(removeDonation).toHaveBeenCalledWith("dq_failed");
    });
  });
});
