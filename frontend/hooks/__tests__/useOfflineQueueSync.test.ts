/**
 * hooks/__tests__/useOfflineQueueSync.test.ts
 *
 * Issue #1129 — proves the app-level queue drain:
 *  - drains on mount with the recordDonation processor + idempotency
 *    pre-check wired in,
 *  - re-drains on the window "online" event and on the service worker's
 *    "indigopay-queue-sync" nudge,
 *  - shows the conflict toast when a queued donation was already processed
 *    (skipped), and
 *  - raises a browser notification when a queued donation was submitted.
 */
import { renderHook, waitFor, act } from "@testing-library/react";
import useOfflineQueueSync from "../useOfflineQueueSync";

jest.mock("@/lib/offlineDonationQueue", () => ({
  syncQueuedDonations: jest.fn(),
}));

jest.mock("@/lib/api", () => ({
  recordDonation: jest.fn(),
  checkIdempotency: jest.fn(),
}));

jest.mock("sonner", () => ({
  toast: jest.fn(),
}));

jest.mock("@/hooks/useOnlineStatus", () => ({
  __esModule: true,
  default: jest.fn(),
}));

import { syncQueuedDonations } from "@/lib/offlineDonationQueue";
import { recordDonation, checkIdempotency } from "@/lib/api";
import { toast } from "sonner";
import useOnlineStatus from "@/hooks/useOnlineStatus";

const mockSyncQueuedDonations = syncQueuedDonations as jest.Mock;
const mockRecordDonation = recordDonation as jest.Mock;
const mockCheckIdempotency = checkIdempotency as jest.Mock;
// sonner's `toast` is a function with callable sub-APIs — go via `unknown`.
const mockToast = toast as unknown as jest.Mock;
const mockUseOnlineStatus = useOnlineStatus as jest.Mock;

const PAYLOAD = {
  projectId: "p_123",
  donorAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  amount: "10",
  currency: "XLM",
  idempotencyKey: "11111111-2222-4333-8444-555555555555",
};

describe("useOfflineQueueSync", () => {
  let swListener: ((event: MessageEvent) => void) | null;
  let originalServiceWorker: unknown;
  let originalNotification: unknown;
  let originalOnLine: boolean;

  beforeEach(() => {
    jest.clearAllMocks();
    // The hook guards with a LIVE navigator.onLine check (never a stale
    // closure), so the tests must control it directly, not just the mock.
    originalOnLine = navigator.onLine;
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: true,
    });
    mockUseOnlineStatus.mockReturnValue(true);
    mockSyncQueuedDonations.mockResolvedValue({
      submitted: 0,
      skipped: 0,
      failed: 0,
    });
    mockRecordDonation.mockResolvedValue({ id: "donation-1" });
    mockCheckIdempotency.mockResolvedValue(false);
    swListener = null;

    originalServiceWorker = navigator.serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: jest.fn(
          (_type: string, cb: (event: MessageEvent) => void) => {
            swListener = cb;
          },
        ),
        removeEventListener: jest.fn(),
      },
    });
  });

  afterEach(() => {
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: originalServiceWorker,
    });
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: originalOnLine,
    });
    if (originalNotification !== undefined) {
      Object.defineProperty(window, "Notification", {
        configurable: true,
        value: originalNotification,
      });
    }
    jest.restoreAllMocks();
  });

  it("drains on mount with the recordDonation processor and the idempotency pre-check", async () => {
    renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(1);
    });

    const [processor, opts] = mockSyncQueuedDonations.mock.calls[0];
    expect(typeof processor).toBe("function");
    expect(typeof opts.checkAlreadyProcessed).toBe("function");

    // The processor records through the API with the queued transaction hash.
    mockRecordDonation.mockResolvedValueOnce({ id: "d" });
    await act(async () => {
      expect(await processor(PAYLOAD)).toBe(true);
    });
    expect(mockRecordDonation).toHaveBeenCalledWith({
      ...PAYLOAD,
      transactionHash: "queued-offline",
    });

    // The pre-check asks the server about the donation's idempotency key.
    mockCheckIdempotency.mockResolvedValueOnce(true);
    await act(async () => {
      expect(await opts.checkAlreadyProcessed(PAYLOAD)).toBe(true);
    });
    expect(mockCheckIdempotency).toHaveBeenCalledWith(PAYLOAD.idempotencyKey);

    // Items without an idempotency key are never pre-checked.
    const noKey = { ...PAYLOAD, idempotencyKey: undefined };
    await act(async () => {
      expect(await opts.checkAlreadyProcessed(noKey)).toBe(false);
    });
    expect(mockCheckIdempotency).not.toHaveBeenCalledWith(undefined);
  });

  it("drains again on the window 'online' event", async () => {
    renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(2);
    });
  });

  it("drains when the service worker posts the background-sync nudge", async () => {
    renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(1);
    });

    expect(swListener).toBeDefined();
    await act(async () => {
      swListener!({ data: "indigopay-queue-sync" } as MessageEvent);
    });

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(2);
    });

    // Messages with other payloads are ignored.
    await act(async () => {
      swListener!({ data: "something-else" } as MessageEvent);
    });
    expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(2);
  });

  it("does not drain while the browser reports offline", async () => {
    mockUseOnlineStatus.mockReturnValue(false);
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      value: false,
    });
    renderHook(() => useOfflineQueueSync());

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    expect(mockSyncQueuedDonations).not.toHaveBeenCalled();
  });

  it("shows the conflict toast when a queued donation was already processed", async () => {
    mockSyncQueuedDonations.mockResolvedValue({
      submitted: 0,
      skipped: 2,
      failed: 0,
    });

    renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        "This donation was already processed while you were offline",
      );
    });
  });

  it("raises a browser notification when queued donations are submitted (permission granted)", async () => {
    originalNotification = window.Notification;
    const showNotification = jest.fn().mockResolvedValue(undefined);
    const MockNotification = jest.fn();
    (MockNotification as unknown as { permission: string }).permission =
      "granted";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });
    Object.defineProperty(navigator.serviceWorker, "getRegistration", {
      configurable: true,
      value: jest.fn().mockResolvedValue({ showNotification }),
    });

    mockSyncQueuedDonations.mockResolvedValue({
      submitted: 2,
      skipped: 0,
      failed: 0,
    });

    renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(showNotification).toHaveBeenCalledWith(
        "Donation confirmed",
        expect.objectContaining({
          body: "2 offline donations were submitted successfully.",
        }),
      );
    });
    expect(mockToast).not.toHaveBeenCalled();
  });

  it("does not notify when Notification permission is not granted", async () => {
    originalNotification = window.Notification;
    const MockNotification = jest.fn();
    (MockNotification as unknown as { permission: string }).permission =
      "denied";
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: MockNotification,
    });

    mockSyncQueuedDonations.mockResolvedValue({
      submitted: 1,
      skipped: 0,
      failed: 0,
    });

    renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(1);
    });
    expect(MockNotification).not.toHaveBeenCalled();
  });

  it("cleans up its listeners on unmount", async () => {
    const { unmount } = renderHook(() => useOfflineQueueSync());

    await waitFor(() => {
      expect(mockSyncQueuedDonations).toHaveBeenCalledTimes(1);
    });

    const removeEventListener = jest.fn();
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: {
        addEventListener: jest.fn(
          (_type: string, cb: (event: MessageEvent) => void) => {
            swListener = cb;
          },
        ),
        removeEventListener,
      },
    });

    unmount();
    expect(removeEventListener).toHaveBeenCalledWith(
      "message",
      expect.any(Function),
    );
  });
});
