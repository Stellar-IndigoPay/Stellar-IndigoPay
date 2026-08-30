/**
 * lib/__tests__/offlineQueue.test.ts
 *
 * Workstream 2 — offline durability.  Tests the IndexedDB-backed queue:
 * conflict resolution against already-processed idempotency keys (zero
 * duplicate records), queued-count reporting for the UI badge, the atomic
 * cross-tab drain lease (only the lease owner processes the queue), and the
 * per-tab sync mutex so one tab never drains twice concurrently.
 *
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto";

import {
  queueDonation,
  getQueuedCount,
  getQueuedDonations,
  syncQueuedDonations,
  setTabIdForTests,
} from "@/lib/offlineDonationQueue";

const DONOR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PROJECT = "p_123";
const IDEMPOTENCY_KEY = "11111111-2222-4333-8444-555555555555";

function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase("indigopay-offline-db");
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    donorAddress: DONOR,
    amount: "10",
    currency: "XLM" as const,
    ...overrides,
  };
}

describe("offlineDonationQueue — Workstream 2", () => {
  beforeEach(async () => {
    await deleteDatabase();
  });

  it("reports the number of queued donations (badge source)", async () => {
    expect(await getQueuedCount()).toBe(0);

    await queueDonation(makePayload({ idempotencyKey: IDEMPOTENCY_KEY }));
    await queueDonation(makePayload());

    expect(await getQueuedCount()).toBe(2);
    expect((await getQueuedDonations()).length).toBe(2);
  });

  it("skips donations the server already recorded (conflict resolution)", async () => {
    await queueDonation(makePayload({ idempotencyKey: IDEMPOTENCY_KEY }));

    const processor = jest.fn().mockResolvedValue(true);
    const checkAlreadyProcessed = jest.fn().mockResolvedValue(true);

    const result = await syncQueuedDonations(processor, {
      checkAlreadyProcessed,
    });

    // The server already had the idempotency key → skipped, never submitted,
    // and dropped from the queue: zero duplicate donation records.
    expect(checkAlreadyProcessed).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: IDEMPOTENCY_KEY }),
    );
    expect(processor).not.toHaveBeenCalled();
    expect(result).toEqual({ submitted: 0, skipped: 1, failed: 0 });
    expect(await getQueuedCount()).toBe(0);
  });

  it("submits and removes items when the processor succeeds", async () => {
    await queueDonation(makePayload());

    const processor = jest.fn().mockResolvedValue(true);
    const result = await syncQueuedDonations(processor);

    expect(processor).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ submitted: 1, skipped: 0, failed: 0 });
    expect(await getQueuedCount()).toBe(0);
  });

  it("keeps failed items queued for a later retry", async () => {
    await queueDonation(makePayload());

    const processor = jest.fn().mockResolvedValue(false);
    const result = await syncQueuedDonations(processor);

    expect(result).toEqual({ submitted: 0, skipped: 0, failed: 1 });
    expect(await getQueuedCount()).toBe(1);
  });

  it("continues draining when a processor call rejects (zero lost donations)", async () => {
    await queueDonation(makePayload({ idempotencyKey: IDEMPOTENCY_KEY }));
    await queueDonation(makePayload({ idempotencyKey: "22222222-3333-4444-8555-666666666666" }));

    // First item's processor throws (e.g. network blip) — the second item must
    // still be attempted instead of the whole batch aborting.
    const processor = jest
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(true);

    const result = await syncQueuedDonations(processor);

    expect(result).toEqual({ submitted: 1, skipped: 0, failed: 1 });
    expect(processor).toHaveBeenCalledTimes(2);
    // The failed item stays queued; the successful one is removed.
    expect(await getQueuedCount()).toBe(1);
  });

  it("does not pre-check items without an idempotency key", async () => {
    await queueDonation(makePayload()); // no idempotencyKey

    const processor = jest.fn().mockResolvedValue(true);
    const checkAlreadyProcessed = jest.fn().mockResolvedValue(true);

    await syncQueuedDonations(processor, { checkAlreadyProcessed });

    expect(checkAlreadyProcessed).not.toHaveBeenCalled();
    expect(processor).toHaveBeenCalledTimes(1);
  });

  it("lets only the lease owner drain — a second tab is denied even after 1s (two-tab browser test)", async () => {
    await queueDonation(makePayload());

    // Tab A acquires the cross-tab lease and its processor stays blocked.
    setTabIdForTests("tab-a");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processorA = jest.fn().mockImplementation(() =>
      gate.then(() => true),
    );

    const syncA = syncQueuedDonations(processorA);
    // Give tab A time to own the lease and enter the (blocked) processor.
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Tab B (same origin, separate tab) attempts to drain while A is stuck.
    setTabIdForTests("tab-b");
    const processorB = jest.fn().mockResolvedValue(true);
    const resultB = await syncQueuedDonations(processorB);

    // The lease denies tab B outright — its processor is never invoked, even
    // though tab A has been blocked well past the 1s window the old
    // BroadcastChannel coordination used to wait out before draining anyway.
    expect(processorB).not.toHaveBeenCalled();
    expect(resultB).toEqual({ submitted: 0, skipped: 0, failed: 0 });

    // Keep tab A blocked past 1s (the old waitForOtherTabSync cap), then let
    // it finish — it alone drains the queue and releases the lease.  Restore
    // tab A's identity BEFORE releasing so its releaseDrainLease recognises
    // itself as the owner and actually deletes the lease.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    setTabIdForTests("tab-a");
    release();
    const resultA = await syncA;
    expect(processorA).toHaveBeenCalledTimes(1);
    expect(resultA).toEqual({ submitted: 1, skipped: 0, failed: 0 });
    expect(await getQueuedCount()).toBe(0);
  });

  it("prevents two concurrent drains in the same tab", async () => {
    await queueDonation(makePayload());

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const processor = jest
      .fn()
      .mockImplementation(() => gate.then(() => true));

    // Start the first drain and let it enter the sync before the second call.
    const first = syncQueuedDonations(processor);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const secondResult = await syncQueuedDonations(processor);

    // The second call bails out on the in-tab mutex without touching items.
    expect(secondResult).toEqual({ submitted: 0, skipped: 0, failed: 0 });
    expect(processor).toHaveBeenCalledTimes(1);

    release();
    const firstResult = await first;
    expect(firstResult.submitted).toBe(1);
  });

  it("never hangs when navigator.serviceWorker.ready never resolves (no SW registered)", async () => {
    // Regression: queueDonation used to `await requestBackgroundSync()`, and
    // navigator.serviceWorker.ready never resolves when no service worker is
    // registered — the record landed in IndexedDB but the caller (and the
    // queued confirmation UI) hung forever. The registration is now
    // fire-and-forget, so queueDonation must resolve immediately.
    const originalSW = (navigator as Navigator & { serviceWorker?: unknown })
      .serviceWorker;
    Object.defineProperty(navigator, "serviceWorker", {
      value: { ready: new Promise<never>(() => {}) },
      configurable: true,
    });
    try {
      const result = await Promise.race([
        queueDonation(makePayload()),
        new Promise<"timeout">((resolve) =>
          setTimeout(() => resolve("timeout"), 500),
        ),
      ]);
      expect(result).not.toBe("timeout");
      expect(await getQueuedCount()).toBe(1);
    } finally {
      Object.defineProperty(navigator, "serviceWorker", {
        value: originalSW,
        configurable: true,
      });
    }
  });
});
