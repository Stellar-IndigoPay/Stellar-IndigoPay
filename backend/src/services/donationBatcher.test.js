/**
 * backend/src/services/donationBatcher.test.js
 *
 * Unit tests for DonationBatcher verifying:
 *   - Donations accumulate within time window
 *   - Batch event emitted after window expires
 *   - Early flush when batch size limit is reached
 *   - Idempotent stop() method
 *   - Empty batches are not emitted
 */
"use strict";

const DonationBatcher = require("./donationBatcher");

describe("DonationBatcher", () => {
  let mockIo;
  let batcher;

  beforeEach(() => {
    jest.useFakeTimers();
    mockIo = { emit: jest.fn() };
    batcher = new DonationBatcher(mockIo, {
      batchWindowMs: 100,
      maxBatchSize: 5,
    });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  test("accumulates donations and flushes after window expires", () => {
    const donation1 = {
      projectId: "proj-1",
      donorAddress: "GAAA",
      amount: "50",
    };
    const donation2 = {
      projectId: "proj-2",
      donorAddress: "GBBB",
      amount: "100",
    };

    batcher.addDonation(donation1);
    batcher.addDonation(donation2);

    // Verify donations are accumulated but not yet emitted
    expect(batcher.getPendingCount()).toBe(2);
    expect(mockIo.emit).not.toHaveBeenCalled();

    // Advance timers past the batch window
    jest.advanceTimersByTime(150);

    // Verify batch was emitted
    expect(mockIo.emit).toHaveBeenCalledTimes(1);
    const [eventName, batch] = mockIo.emit.mock.calls[0];
    expect(eventName).toBe("donation_batch");
    expect(batch.donations).toHaveLength(2);
    expect(batch.donations[0]).toEqual(donation1);
    expect(batch.donations[1]).toEqual(donation2);
    expect(batch.batchId).toBeDefined();
    expect(batch.timestamp).toBeDefined();

    // Verify accumulator is reset
    expect(batcher.getPendingCount()).toBe(0);
  });

  test("flushes early when batch size limit is reached", () => {
    for (let i = 0; i < 5; i++) {
      batcher.addDonation({
        projectId: `proj-${i}`,
        donorAddress: `GADR${i}`,
        amount: "10",
      });
    }

    // Early flush should trigger since we hit maxBatchSize
    expect(mockIo.emit).toHaveBeenCalledTimes(1);
    const batch = mockIo.emit.mock.calls[0][1];
    expect(batch.donations).toHaveLength(5);
    expect(batcher.getPendingCount()).toBe(0);
  });

  test("does not emit empty batch", () => {
    batcher.flush(); // explicit flush with no donations
    expect(mockIo.emit).not.toHaveBeenCalled();
    expect(batcher.getPendingCount()).toBe(0);
  });

  test("stop() flushes pending donations and cancels timer", () => {
    const donation = {
      projectId: "proj-1",
      donorAddress: "GAAA",
      amount: "50",
    };

    batcher.addDonation(donation);
    expect(batcher.getPendingCount()).toBe(1);
    expect(mockIo.emit).not.toHaveBeenCalled();

    // Stop should immediately flush
    batcher.stop();
    expect(batcher.getPendingCount()).toBe(0);
    expect(mockIo.emit).toHaveBeenCalledTimes(1);
    expect(mockIo.emit.mock.calls[0][1].donations).toHaveLength(1);
  });

  test("stop() is idempotent", () => {
    batcher.stop();
    expect(mockIo.emit).not.toHaveBeenCalled(); // no donations to flush

    batcher.stop();
    expect(mockIo.emit).not.toHaveBeenCalled(); // still nothing

    expect(batcher.getPendingCount()).toBe(0);
  });

  test("rejects null donation", () => {
    expect(() => batcher.addDonation(null)).toThrow();
    expect(() => batcher.addDonation(undefined)).toThrow();
  });

  test("schedules multiple batches sequentially", () => {
    // First batch
    batcher.addDonation({ projectId: "proj-1", donorAddress: "GAAA", amount: "10" });
    jest.advanceTimersByTime(150);
    expect(mockIo.emit).toHaveBeenCalledTimes(1);

    // Second batch
    batcher.addDonation({ projectId: "proj-2", donorAddress: "GBBB", amount: "20" });
    jest.advanceTimersByTime(150);
    expect(mockIo.emit).toHaveBeenCalledTimes(2);

    // Verify both batches had correct data
    const batch1 = mockIo.emit.mock.calls[0][1];
    const batch2 = mockIo.emit.mock.calls[1][1];
    expect(batch1.donations[0].projectId).toBe("proj-1");
    expect(batch2.donations[0].projectId).toBe("proj-2");
  });

  test("cancels and reschedules timer on new donation after window starts", () => {
    batcher.addDonation({ projectId: "proj-1", donorAddress: "GAAA", amount: "10" });
    jest.advanceTimersByTime(50);
    expect(mockIo.emit).not.toHaveBeenCalled();

    // Add another donation mid-window
    batcher.addDonation({ projectId: "proj-2", donorAddress: "GBBB", amount: "20" });
    // Timer should restart (still only 50ms elapsed since first donation)
    expect(mockIo.emit).not.toHaveBeenCalled();

    // Advance past original window (150ms total)
    jest.advanceTimersByTime(100);
    // Should still not have emitted since we're only 150ms past first donation
    // but batched new donations should come through after their own window
    expect(mockIo.emit).toHaveBeenCalledTimes(1);
  });

  test("setIO allows dynamic Socket.IO replacement", () => {
    const donation = { projectId: "proj-1", donorAddress: "GAAA", amount: "10" };
    batcher.addDonation(donation);

    const newIo = { emit: jest.fn() };
    batcher.setIO(newIo);

    jest.advanceTimersByTime(150);

    expect(mockIo.emit).not.toHaveBeenCalled();
    expect(newIo.emit).toHaveBeenCalledTimes(1);
  });

  test("batch payload includes unique batchId and valid timestamp", () => {
    batcher.addDonation({ projectId: "proj-1", donorAddress: "GAAA", amount: "10" });
    jest.advanceTimersByTime(150);

    const batch = mockIo.emit.mock.calls[0][1];
    expect(batch.batchId).toMatch(/^[0-9a-f-]{36}$/); // UUID v4 format
    expect(new Date(batch.timestamp).getTime()).toBeTruthy();
  });

  test("drops oldest donations beyond maxPendingDonations and increments drop counter", () => {
    const overflowBatcher = new DonationBatcher(mockIo, {
      batchWindowMs: 100,
      maxBatchSize: 1000,
      maxPendingDonations: 5,
    });

    for (let i = 0; i < 8; i++) {
      overflowBatcher.addDonation({
        projectId: `proj-${i}`,
        donorAddress: `GADR${i}`,
        amount: "10",
      });
    }

    // 8 added, cap 5 → 3 dropped
    expect(overflowBatcher.getPendingCount()).toBe(5);
    const stats = overflowBatcher.getStats();
    expect(stats.totalDropped).toBe(3);
    expect(stats.pending).toBe(5);

    // The oldest donations (proj-0, proj-1, proj-2) should have been dropped.
    overflowBatcher.flush();
    const batch = mockIo.emit.mock.calls[0][1];
    expect(batch.donations[0].projectId).toBe("proj-3");
    expect(batch.donations[4].projectId).toBe("proj-7");
  });

  test("getStats exposes pending, totalFlushed and totalDropped", () => {
    batcher.addDonation({ projectId: "proj-1", donorAddress: "GAAA", amount: "10" });
    expect(batcher.getStats()).toEqual({ pending: 1, totalFlushed: 0, totalDropped: 0 });

    jest.advanceTimersByTime(150);
    expect(batcher.getStats()).toEqual({ pending: 0, totalFlushed: 1, totalDropped: 0 });
  });

  test("pauses accumulation when Socket.IO adapter is disconnected", () => {
    const adapter = { on: jest.fn() };
    const ioWithAdapter = {
      emit: jest.fn(),
      of: () => ({ adapter }),
    };
    const disconnectBatcher = new DonationBatcher(ioWithAdapter, {
      batchWindowMs: 100,
      maxBatchSize: 1000,
    });

    // Capture the disconnect handler
    const disconnectHandler = adapter.on.mock.calls.find(([evt]) => evt === "disconnect")[1];
    const connectHandler = adapter.on.mock.calls.find(([evt]) => evt === "connect")[1];

    disconnectHandler();
    disconnectBatcher.addDonation({ projectId: "proj-1", donorAddress: "GAAA", amount: "10" });
    expect(disconnectBatcher.getPendingCount()).toBe(0);

    connectHandler();
    disconnectBatcher.addDonation({ projectId: "proj-2", donorAddress: "GBBB", amount: "20" });
    expect(disconnectBatcher.getPendingCount()).toBe(1);
  });
});
