/**
 * __tests__/utils/donationQueue.test.ts
 *
 * Unit tests for the offline donation queue.
 *
 * Coverage:
 *   - enqueueDonation: creates entry with correct initial state
 *   - getQueuedDonations: returns FIFO order
 *   - getPendingCount: counts pending + retrying only
 *   - getRetryEligibleDonations: respects nextRetryAt and maxAttempts
 *   - markSubmitted: transitions to submitted with tx hash
 *   - markFailed: increments attempts, schedules next retry with backoff
 *   - markFailed: transitions to failed after max attempts
 *   - removeDonation: removes specific entry
 *   - cleanQueue: removes completed/failed entries only
 *   - clearQueue: removes all entries
 *   - RETRY_BACKOFF_MS schedule matches spec
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  enqueueDonation,
  getQueuedDonations,
  getPendingCount,
  getRetryEligibleDonations,
  getItemStatus,
  getRetryEligible,
  markSubmitted,
  markFailed,
  retryDonation,
  onQueueItemUpdate,
  removeDonation,
  cleanQueue,
  clearQueue,
  getQueueSummary,
  RETRY_BACKOFF_MS,
  MAX_RETRY_ATTEMPTS,
} from "../../utils/donationQueue";

const mockDonation = {
  projectId: "proj-1",
  projectName: "Amazon Reforestation",
  amount: "10.0000000",
  currency: "XLM" as const,
  donorAddress: "GDONOR...TEST",
  message: "Keep up the great work!",
};

beforeEach(async () => {
  await AsyncStorage.clear();
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("enqueueDonation", () => {
  test("creates a donation with initial pending status", async () => {
    const d = await enqueueDonation(mockDonation);

    expect(d.id).toBeDefined();
    expect(d.id).toMatch(/^dq_/);
    expect(d.projectId).toBe("proj-1");
    expect(d.projectName).toBe("Amazon Reforestation");
    expect(d.amount).toBe("10.0000000");
    expect(d.currency).toBe("XLM");
    expect(d.donorAddress).toBe("GDONOR...TEST");
    expect(d.message).toBe("Keep up the great work!");
    expect(d.status).toBe("pending");
    expect(d.attempts).toBe(0);
    expect(d.maxAttempts).toBe(6);
    expect(d.nextRetryAt).toBeLessThanOrEqual(Date.now());
    expect(d.createdAt).toBeGreaterThan(0);
    expect(d.updatedAt).toBeGreaterThan(0);
  });

  test("persists to AsyncStorage", async () => {
    await enqueueDonation(mockDonation);

    const raw = await AsyncStorage.getItem("donation_queue");
    expect(raw).not.toBeNull();

    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].projectName).toBe("Amazon Reforestation");
  });
});

describe("getQueuedDonations", () => {
  test("returns donations in FIFO order (oldest first)", async () => {
    const d1 = await enqueueDonation({ ...mockDonation, projectName: "First" });
    // Advance time so second donation has a later createdAt
    jest.advanceTimersByTime(100);
    const d2 = await enqueueDonation({ ...mockDonation, projectName: "Second" });

    const list = await getQueuedDonations();
    expect(list).toHaveLength(2);
    expect(list[0].id).toBe(d1.id);
    expect(list[1].id).toBe(d2.id);
  });

  test("returns empty array when queue is empty", async () => {
    const list = await getQueuedDonations();
    expect(list).toEqual([]);
  });
});

describe("getPendingCount", () => {
  test("counts only pending and retrying donations", async () => {
    await enqueueDonation(mockDonation);
    const d2 = await enqueueDonation({ ...mockDonation, projectName: "Second" });
    await markSubmitted(d2.id, "tx_hash");

    const count = await getPendingCount();
    expect(count).toBe(1); // only the first, which is still pending
  });

  test("returns 0 for empty queue", async () => {
    const count = await getPendingCount();
    expect(count).toBe(0);
  });
});

describe("getRetryEligibleDonations", () => {
  test("returns donations whose nextRetryAt <= now and status is pending", async () => {
    const d = await enqueueDonation(mockDonation);
    // Default nextRetryAt is Date.now(), which is in the past with fake timers
    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe(d.id);
  });

  test("excludes donations with nextRetryAt in the future", async () => {
    const d = await enqueueDonation(mockDonation);
    // Mark failed once — nextRetryAt will be set to now + 30s
    await markFailed(d.id, "Network error");
    jest.advanceTimersByTime(10_000); // only 10s passed, 30s backoff not yet

    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(0);
  });

  test("includes donations whose backoff period has elapsed", async () => {
    const d = await enqueueDonation(mockDonation);
    await markFailed(d.id, "Network error");
    jest.advanceTimersByTime(35_000); // 35s > 30s backoff

    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe(d.id);
  });

  test("excludes donations that have exceeded max attempts", async () => {
    const d = await enqueueDonation(mockDonation);
    // Fail it 6 times to exhaust attempts, advancing just past each backoff step
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      await markFailed(d.id, `Attempt ${i + 1} failed`);
      // Advance just past the current backoff step (plus a small buffer)
      const backoffMs = RETRY_BACKOFF_MS[Math.min(i, RETRY_BACKOFF_MS.length - 1)];
      jest.advanceTimersByTime(backoffMs + 1_000);
    }

    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(0);
  });

  test("excludes submitted/failed status", async () => {
    const d1 = await enqueueDonation(mockDonation);
    const d2 = await enqueueDonation({ ...mockDonation, projectName: "Second" });
    await markSubmitted(d1.id, "tx_hash");

    // Exhaust d2
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      await markFailed(d2.id, `Attempt ${i + 1}`);
      const backoffMs = RETRY_BACKOFF_MS[Math.min(i, RETRY_BACKOFF_MS.length - 1)];
      jest.advanceTimersByTime(backoffMs + 1_000);
    }

    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(0);
  });
});

describe("markSubmitted", () => {
  test("updates status and stores transaction hash", async () => {
    const d = await enqueueDonation(mockDonation);
    await markSubmitted(d.id, "abc123");

    const list = await getQueuedDonations();
    expect(list[0].status).toBe("submitted");
    expect(list[0].transactionHash).toBe("abc123");
  });

  test("does nothing for unknown id", async () => {
    await expect(markSubmitted("nonexistent", "tx")).resolves.toBeUndefined();
  });
});

describe("markFailed", () => {
  test("increments attempts and schedules next retry with backoff", async () => {
    const d = await enqueueDonation(mockDonation);
    const before = d.nextRetryAt;

    await markFailed(d.id, "Network timeout");

    const list = await getQueuedDonations();
    expect(list[0].attempts).toBe(1);
    expect(list[0].status).toBe("pending");
    expect(list[0].lastError).toBe("Network timeout");
    // nextRetryAt should be now + RETRY_BACKOFF_MS[0] (30s)
    expect(list[0].nextRetryAt).toBeGreaterThanOrEqual(
      Date.now() + RETRY_BACKOFF_MS[0] - 100,
    );
  });

  test("transitions to failed after max attempts", async () => {
    const d = await enqueueDonation(mockDonation);
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      await markFailed(d.id, `Attempt ${i + 1}`);
    }

    const list = await getQueuedDonations();
    expect(list[0].status).toBe("failed");
    expect(list[0].attempts).toBe(MAX_RETRY_ATTEMPTS);
    expect(list[0].nextRetryAt).toBe(0);
  });
});

describe("removeDonation", () => {
  test("removes the specified donation from the queue", async () => {
    const d1 = await enqueueDonation(mockDonation);
    const d2 = await enqueueDonation({ ...mockDonation, projectName: "Second" });

    await removeDonation(d1.id);

    const list = await getQueuedDonations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(d2.id);
  });
});

describe("cleanQueue", () => {
  test("removes submitted and failed entries, keeps pending", async () => {
    const d1 = await enqueueDonation(mockDonation);
    const d2 = await enqueueDonation({ ...mockDonation, projectName: "Second" });
    const d3 = await enqueueDonation({ ...mockDonation, projectName: "Third" });
    await markSubmitted(d2.id, "tx_hash");
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      await markFailed(d3.id, `Attempt ${i + 1}`);
    }

    await cleanQueue();

    const list = await getQueuedDonations();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(d1.id);
  });
});

describe("clearQueue", () => {
  test("removes all donations", async () => {
    await enqueueDonation(mockDonation);
    await enqueueDonation(mockDonation);

    await clearQueue();

    const list = await getQueuedDonations();
    expect(list).toEqual([]);
  });
});

describe("getQueueSummary", () => {
  test("returns correct counts for each status", async () => {
    const d1 = await enqueueDonation(mockDonation);
    const d2 = await enqueueDonation({ ...mockDonation, projectName: "S" });
    const d3 = await enqueueDonation({ ...mockDonation, projectName: "T" });
    await markSubmitted(d2.id, "tx");
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      await markFailed(d3.id, `A${i + 1}`);
    }

    const summary = await getQueueSummary();
    expect(summary.total).toBe(3);
    expect(summary.pending).toBe(1); // d1 still pending
    expect(summary.submitted).toBe(1); // d2 submitted
    expect(summary.failed).toBe(1); // d3 failed
    expect(summary.retrying).toBe(0);
  });
});

describe("RETRY_BACKOFF_MS schedule", () => {
  test("matches the 6-step exponential backoff spec", () => {
    expect(RETRY_BACKOFF_MS).toHaveLength(6);
    // 30s, 2m, 10m, 30m, 2h, 6h
    expect(RETRY_BACKOFF_MS[0]).toBe(30_000);
    expect(RETRY_BACKOFF_MS[1]).toBe(120_000);
    expect(RETRY_BACKOFF_MS[2]).toBe(600_000);
    expect(RETRY_BACKOFF_MS[3]).toBe(1_800_000);
    expect(RETRY_BACKOFF_MS[4]).toBe(7_200_000);
    expect(RETRY_BACKOFF_MS[5]).toBe(21_600_000);
  });
});

describe("getItemStatus", () => {
  test("returns the status of a queued donation", async () => {
    const d = await enqueueDonation(mockDonation);
    expect(await getItemStatus(d.id)).toBe("pending");
    await markSubmitted(d.id, "tx");
    expect(await getItemStatus(d.id)).toBe("submitted");
  });

  test("returns null for unknown id", async () => {
    expect(await getItemStatus("missing")).toBeNull();
  });
});

describe("getRetryEligible alias", () => {
  test("returns the same set as getRetryEligibleDonations", async () => {
    await enqueueDonation(mockDonation);
    const a = await getRetryEligible();
    const b = await getRetryEligibleDonations();
    expect(a).toHaveLength(b.length);
    expect(a[0].id).toBe(b[0].id);
  });
});

describe("markFailed permanent vs retryable", () => {
  test("permanent failure marks donation non-retryable and failed", async () => {
    const d = await enqueueDonation(mockDonation);
    await markFailed(d.id, "Project deleted", {
      permanent: true,
      errorCode: "PROJECT_NOT_FOUND",
    });

    const list = await getQueuedDonations();
    expect(list[0].status).toBe("failed");
    expect(list[0].retryable).toBe(false);
    expect(list[0].errorCode).toBe("PROJECT_NOT_FOUND");

    // No longer eligible for retry even though attempts < maxAttempts.
    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(0);
  });

  test("non-permanent failure stays retryable and reschedules", async () => {
    const d = await enqueueDonation(mockDonation);
    await markFailed(d.id, "Network timeout", {
      errorCode: undefined,
    });

    const list = await getQueuedDonations();
    expect(list[0].status).toBe("pending");
    expect(list[0].retryable).toBe(true);
    expect(list[0].nextRetryAt).toBeGreaterThan(Date.now());
  });

  test("exhausting max attempts becomes permanent automatically", async () => {
    const d = await enqueueDonation(mockDonation);
    for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
      await markFailed(d.id, `Attempt ${i + 1}`);
    }
    const list = await getQueuedDonations();
    expect(list[0].status).toBe("failed");
    expect(list[0].retryable).toBe(false);
  });
});

describe("retryDonation", () => {
  test("re-queues a failed donation as immediately retryable", async () => {
    const d = await enqueueDonation(mockDonation);
    await markFailed(d.id, "Project deleted", { permanent: true });
    expect(await getItemStatus(d.id)).toBe("failed");

    await retryDonation(d.id);

    const list = await getQueuedDonations();
    expect(list[0].status).toBe("pending");
    expect(list[0].retryable).toBe(true);
    expect(list[0].attempts).toBe(0);
    const eligible = await getRetryEligibleDonations();
    expect(eligible).toHaveLength(1);
  });
});

describe("onQueueItemUpdate subscription", () => {
  test("notifies listeners after a mutation", async () => {
    const listener = jest.fn();
    const unsub = onQueueItemUpdate(listener);

    await enqueueDonation(mockDonation);

    expect(listener).toHaveBeenCalled();
    const snapshot = listener.mock.calls[listener.mock.calls.length - 1][0];
    expect(Array.isArray(snapshot)).toBe(true);
    expect(snapshot).toHaveLength(1);

    unsub();
    listener.mockClear();
    await enqueueDonation(mockDonation);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("queue persistence", () => {
  test("donations survive an AsyncStorage read/write round-trip", async () => {
    const d = await enqueueDonation(mockDonation);
    await markFailed(d.id, "boom", { permanent: true, errorCode: "TX_FAILED" });

    // Re-read straight from storage to prove persistence of new fields.
    const raw = await AsyncStorage.getItem("donation_queue");
    const parsed = JSON.parse(raw!);
    expect(parsed[0].id).toBe(d.id);
    expect(parsed[0].status).toBe("failed");
    expect(parsed[0].retryable).toBe(false);
    expect(parsed[0].errorCode).toBe("TX_FAILED");
  });
});
