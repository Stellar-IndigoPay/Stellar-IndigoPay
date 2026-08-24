/**
 * lib/__tests__/offlineQueue.test.ts
 *
 * Workstream 2 — offline durability.  Tests the IndexedDB-backed queue:
 * conflict resolution against already-processed idempotency keys (zero
 * duplicate records), queued-count reporting for the UI badge, and the
 * per-tab sync mutex so two tabs never drain the queue simultaneously.
 *
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto";

import {
  queueDonation,
  getQueuedCount,
  getQueuedDonations,
  syncQueuedDonations,
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
