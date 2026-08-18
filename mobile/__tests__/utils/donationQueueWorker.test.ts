/**
 * __tests__/utils/donationQueueWorker.test.ts
 *
 * Unit tests for the offline donation retry worker.
 *
 * Coverage:
 *   - a failed middle donation does NOT stop later queued donations
 *   - permanent (non-retryable) failures are marked failed + retryable=false
 *   - retryable failures are rescheduled (retryable=true)
 *   - duplicate idempotency replay is treated as completed
 *   - processQueue is guarded against concurrent runs (no double submit)
 */
import axios from "axios";

jest.mock("../../utils/donationQueue", () => {
  const real = jest.requireActual("../../utils/donationQueue");
  return {
    __esModule: true,
    ...real,
    getRetryEligibleDonations: jest.fn(),
    markRetrying: jest.fn().mockResolvedValue(undefined),
    markSubmitted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    retryDonation: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../../utils/failureClassifier", () => ({
  classifyFailure: jest.fn(),
  isDuplicateResponse: jest.fn(),
}));

jest.mock("../../utils/connectivity", () => ({
  subscribe: jest.fn(() => jest.fn()),
  startConnectivityWatcher: jest.fn(),
  stopConnectivityWatcher: jest.fn(),
  isOnline: jest.fn(() => true),
  checkNow: jest.fn(),
}));

import {
  processQueue,
  isSyncing,
} from "../../utils/donationQueueWorker";
import {
  getRetryEligibleDonations,
  markRetrying,
  markSubmitted,
  markFailed,
} from "../../utils/donationQueue";
import { classifyFailure, isDuplicateResponse } from "../../utils/failureClassifier";

const mkDonation = (id: string, projectId = "p1") => ({
  id,
  projectId,
  projectName: "Project",
  amount: "10",
  currency: "XLM" as const,
  donorAddress: "G",
  status: "pending" as const,
  attempts: 0,
  maxAttempts: 6,
  nextRetryAt: 0,
  retryable: true,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

beforeEach(() => {
  jest.clearAllMocks();
  (axios.post as jest.Mock).mockReset();
  (markRetrying as jest.Mock).mockResolvedValue(undefined);
  (markSubmitted as jest.Mock).mockResolvedValue(undefined);
  (markFailed as jest.Mock).mockResolvedValue(undefined);
});

describe("processQueue — middle failure does not block others", () => {
  test("a failed middle donation still lets later donations succeed", async () => {
    const d1 = mkDonation("d1");
    const d2 = mkDonation("d2");
    const d3 = mkDonation("d3");
    (getRetryEligibleDonations as jest.Mock).mockResolvedValue([d1, d2, d3]);

    // d1 success, d2 permanent failure, d3 success
    (axios.post as jest.Mock)
      .mockResolvedValueOnce({ status: 201, data: { data: { transactionHash: "tx1" } } })
      .mockRejectedValueOnce({
        response: { status: 404, data: { error: { code: "PROJECT_NOT_FOUND" } } },
      })
      .mockResolvedValueOnce({ status: 201, data: { data: { transactionHash: "tx3" } } });

    (classifyFailure as jest.Mock).mockReturnValue({
      retryable: false,
      errorCode: "PROJECT_NOT_FOUND",
    });

    const result = await processQueue();

    expect(result.submitted).toBe(2);
    expect(result.failed).toBe(1);
    expect(markSubmitted).toHaveBeenCalledWith("d1", "tx1");
    expect(markSubmitted).toHaveBeenCalledWith("d3", "tx3");
    // d2 marked failed + permanent
    expect(markFailed).toHaveBeenCalledWith(
      "d2",
      expect.any(String),
      expect.objectContaining({ permanent: true, errorCode: "PROJECT_NOT_FOUND" }),
    );
  });
});

describe("processQueue — retryable vs permanent", () => {
  test("retryable failure keeps the donation eligible (retryable=true)", async () => {
    const d = mkDonation("d1");
    (getRetryEligibleDonations as jest.Mock).mockResolvedValue([d]);
    (axios.post as jest.Mock).mockRejectedValue({
      message: "Network Error",
      code: "ECONNABORTED",
    });
    (classifyFailure as jest.Mock).mockReturnValue({
      retryable: true,
      reason: "Network/timeout error",
    });

    const result = await processQueue();
    expect(result.failed).toBe(1);
    expect(markFailed).toHaveBeenCalledWith(
      "d1",
      expect.any(String),
      expect.objectContaining({ permanent: false, errorCode: undefined }),
    );
  });

  test("permanent failure is non-retryable", async () => {
    const d = mkDonation("d1");
    (getRetryEligibleDonations as jest.Mock).mockResolvedValue([d]);
    (axios.post as jest.Mock).mockRejectedValue({
      response: { status: 400, data: { error: { code: "TX_FAILED" } } },
    });
    (classifyFailure as jest.Mock).mockReturnValue({
      retryable: false,
      errorCode: "TX_FAILED",
    });

    await processQueue();
    expect(markFailed).toHaveBeenCalledWith(
      "d1",
      expect.any(String),
      expect.objectContaining({ permanent: true, errorCode: "TX_FAILED" }),
    );
  });
});

describe("processQueue — duplicate idempotency replay", () => {
  test("duplicate response is treated as completed", async () => {
    const d = mkDonation("d1");
    (getRetryEligibleDonations as jest.Mock).mockResolvedValue([d]);
    (axios.post as jest.Mock).mockResolvedValue({
      status: 200,
      data: { duplicate: true, data: { transactionHash: "tx-existing" } },
    });
    (isDuplicateResponse as jest.Mock).mockReturnValue(true);

    const result = await processQueue();
    expect(result.submitted).toBe(1);
    expect(markSubmitted).toHaveBeenCalledWith("d1", "tx-existing");
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe("processQueue — concurrency guard", () => {
  test("a second concurrent processQueue is a no-op (no double submit)", async () => {
    const d = mkDonation("d1");
    (getRetryEligibleDonations as jest.Mock).mockResolvedValue([d]);

    let resolvePost: (v: any) => void = () => {};
    (axios.post as jest.Mock).mockReturnValue(
      new Promise((res) => {
        resolvePost = res;
      }),
    );

    const p1 = processQueue();
    // isSyncing should be true while the first pass is in flight
    expect(isSyncing()).toBe(true);
    const p2 = processQueue(); // should short-circuit

    resolvePost({ status: 201, data: { data: { transactionHash: "tx" } } });
    await Promise.all([p1, p2]);

    // Exactly one POST for d1 despite two processQueue calls.
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(markSubmitted).toHaveBeenCalledTimes(1);
    expect(isSyncing()).toBe(false);
  });
});
