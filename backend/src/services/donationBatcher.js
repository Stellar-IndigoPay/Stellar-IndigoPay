/**
 * src/services/donationBatcher.js
 *
 * Batches donation events over a configurable time window to reduce
 * Socket.IO fan-out complexity from O(clients × donations) to O(clients × batches).
 *
 * Under high donation volume (e.g., 100+ donations/sec during fundraising peaks),
 * unbatched events cause CPU amplification and janky UI. This module accumulates
 * donations over a window (default 500ms) and emits a single `donation_batch` event
 * per window instead of one event per donation.
 *
 * Backpressure & observability:
 *   - A hard cap (`maxPendingDonations`, default 500) bounds the in-memory pending
 *     queue. When the cap is exceeded, the oldest donations are dropped and a
 *     `donation_batcher_drop_total` prometheus counter is incremented.
 *   - `donation_batch_size` and `donation_batch_flush_duration_seconds` histograms
 *     expose batch-size distribution and flush latency to operators.
 *   - When the Socket.IO Redis adapter is disconnected, the batcher logs an error
 *     and stops accumulating (graceful degradation) until the adapter reconnects.
 *   - `getStats()` exposes pending count, total flushed, and total dropped.
 *
 * Usage:
 *   const batcher = new DonationBatcher(io, { batchWindowMs: 500 });
 *   batcher.addDonation({ projectId, donorAddress, amountXLM, ... });
 *   // After 500ms of no new donations, or when batch is flushed,
 *   // emits: io.emit("donation_batch", { donations: [...], batchId, timestamp })
 */
"use strict";

const { v4: uuid } = require("uuid");
const logger = require("../logger");
const { metrics } = require("./metrics");

const {
  donationBatcherDropTotal,
  donationBatchSize,
  donationBatchFlushDurationSeconds,
} = metrics;

class DonationBatcher {
  /**
   * @param {import("socket.io").Server} io - Socket.IO server instance for emitting events.
   * @param {{batchWindowMs?: number, maxBatchSize?: number, maxPendingDonations?: number}} [options={}]
   *   - batchWindowMs: milliseconds to wait before flushing (default 500)
   *   - maxBatchSize: max donations per batch; flush early if exceeded (default 50)
   *   - maxPendingDonations: hard cap on pending donations; beyond this the oldest
   *     are dropped with a `donation_batcher_drop_total` counter increment (default 500)
   */
  constructor(io, options = {}) {
    this.io = io;
    this.batchWindowMs = options.batchWindowMs ?? 500;
    this.maxBatchSize = options.maxBatchSize ?? 50;
    this.maxPendingDonations = options.maxPendingDonations ?? 500;

    this.donations = []; // accumulator
    this.batchTimer = null;
    this.isFlushScheduled = false;

    // Stats / observability
    this.totalFlushed = 0;
    this.totalDropped = 0;

    // Redis adapter connectivity state. When the adapter is disconnected we
    // stop accumulating (graceful degradation) to avoid unbounded memory growth.
    this.adapterConnected = true;
    this._bindAdapterEvents();
  }

  /**
   * Bind to the Socket.IO Redis adapter's connect/disconnect events so we can
   * pause accumulation when the adapter is down. If no adapter is present (e.g.
   * in-memory adapter or tests), we treat the adapter as always connected.
   * @private
   */
  _bindAdapterEvents() {
    if (!this.io || !this.io.of) return;
    const adapter = this.io.of("/").adapter;
    if (!adapter) return;

    if (typeof adapter.on === "function") {
      adapter.on("connect", () => {
        this.adapterConnected = true;
        logger.info({ event: "donation_batcher_adapter_connected" }, "Socket.IO adapter connected; donation batching resumed");
      });
      adapter.on("disconnect", () => {
        this.adapterConnected = false;
        logger.error({ event: "donation_batcher_adapter_disconnected" }, "Socket.IO adapter disconnected; donation batching paused");
      });
    }
  }

  /**
   * Add a single donation to the batch. Schedules a flush if not already scheduled.
   * Flushes early if batch size reaches maxBatchSize.
   *
   * Backpressure: if the pending queue exceeds `maxPendingDonations`, the oldest
   * donations are dropped (FIFO) and `donation_batcher_drop_total` is incremented.
   *
   * @param {object} donation - Donation object with projectId, donorAddress, amountXLM, etc.
   */
  addDonation(donation) {
    if (!donation || typeof donation !== "object") {
      throw new Error("addDonation requires a non-null donation object");
    }

    // Graceful degradation: if the Socket.IO Redis adapter is disconnected,
    // stop accumulating to avoid unbounded memory growth.
    if (!this.adapterConnected) {
      this.totalDropped += 1;
      donationBatcherDropTotal.inc();
      return;
    }

    this.donations.push(donation);

    // Backpressure: enforce the hard cap on pending donations. Drop the oldest
    // donations (FIFO) beyond the cap and record the drop.
    while (this.donations.length > this.maxPendingDonations) {
      this.donations.shift();
      this.totalDropped += 1;
      donationBatcherDropTotal.inc();
    }

    // Early flush if batch is full
    if (this.donations.length >= this.maxBatchSize) {
      this.flush();
      return;
    }

    // Schedule a flush if not already scheduled
    if (!this.isFlushScheduled) {
      this._scheduleFlush();
    }
  }

  /**
   * Schedule a flush after batchWindowMs. Cancels any pending flush.
   * @private
   */
  _scheduleFlush() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.isFlushScheduled = true;
    this.batchTimer = setTimeout(() => {
      this.flush();
    }, this.batchWindowMs);
  }

  /**
   * Immediately emit the current batch and reset the accumulator.
   * If no donations are queued, this is a no-op.
   */
  flush() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.isFlushScheduled = false;

    if (this.donations.length === 0) {
      return;
    }

    const batch = {
      donations: this.donations,
      batchId: uuid(),
      timestamp: new Date().toISOString(),
    };

    const start = process.hrtime.bigint();

    // Emit the batch to all connected clients
    if (this.io && typeof this.io.emit === "function") {
      this.io.emit("donation_batch", batch);
    }

    // Record flush latency and batch size
    const elapsedSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    donationBatchFlushDurationSeconds.observe(elapsedSeconds);
    donationBatchSize.observe(batch.donations.length);

    // Reset the accumulator
    this.totalFlushed += this.donations.length;
    this.donations = [];
  }

  /**
   * Immediately flush any pending donations and stop the scheduler.
   * Idempotent.
   */
  stop() {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    this.isFlushScheduled = false;
    this.flush();
  }

  /**
   * Return the current batch size (for testing/monitoring).
   */
  getPendingCount() {
    return this.donations.length;
  }

  /**
   * Return operational stats for monitoring/health endpoints.
   *
   * @returns {{pending: number, totalFlushed: number, totalDropped: number,
   *   adapterConnected: boolean}}
   */
  getStats() {
    return {
      pending: this.donations.length,
      totalFlushed: this.totalFlushed,
      totalDropped: this.totalDropped,
      adapterConnected: this.adapterConnected,
    };
  }

  /**
   * Replace the Socket.IO instance (useful for testing).
   */
  setIO(io) {
    this.io = io;
    this._bindAdapterEvents();
  }
}

module.exports = DonationBatcher;
