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
 * Backpressure: the accumulator is bounded by `maxPendingDonations` (default 500).
 * When the bound is exceeded, the oldest donations are dropped and a
 * `donation_batcher_drop_total` Prometheus counter is incremented. If the
 * Socket.IO Redis adapter is disconnected, the batcher logs an error and stops
 * accumulating (graceful degradation) until the adapter reconnects.
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
const {
  donationBatcherDropTotal,
  donationBatchSize,
  donationBatchFlushDurationSeconds,
} = require("./metrics");

class DonationBatcher {
  /**
   * @param {import("socket.io").Server} io - Socket.IO server instance for emitting events.
   * @param {{batchWindowMs?: number, maxBatchSize?: number, maxPendingDonations?: number}} [options={}]
   *   - batchWindowMs: milliseconds to wait before flushing (default 500)
   *   - maxBatchSize: max donations per batch; flush early if exceeded (default 50)
   *   - maxPendingDonations: hard cap on accumulated donations before oldest are dropped (default 500)
   */
  constructor(io, options = {}) {
    this.io = io;
    this.batchWindowMs = options.batchWindowMs ?? 500;
    this.maxBatchSize = options.maxBatchSize ?? 50;
    this.maxPendingDonations = options.maxPendingDonations ?? 500;

    this.donations = []; // accumulator
    this.batchTimer = null;
    this.isFlushScheduled = false;

    // Observability / stats
    this.totalFlushed = 0;
    this.totalDropped = 0;

    // Graceful degradation when the Socket.IO Redis adapter is disconnected.
    this._adapterDisconnected = false;
    this._bindAdapterEvents();
  }

  /**
   * Bind to the Socket.IO adapter's connect/disconnect events so we can pause
   * accumulation when the Redis adapter is down and resume when it returns.
   * @private
   */
  _bindAdapterEvents() {
    if (!this.io || !this.io.of || typeof this.io.of !== "function") {
      return;
    }
    const adapter = this.io.of("/").adapter;
    if (!adapter) {
      return;
    }
    if (typeof adapter.on === "function") {
      adapter.on("connect", () => {
        this._adapterDisconnected = false;
        logger.info({ event: "donation_batcher_adapter_connected" }, "Socket.IO adapter reconnected; donation batching resumed");
      });
      adapter.on("disconnect", () => {
        this._adapterDisconnected = true;
        logger.error({ event: "donation_batcher_adapter_disconnected" }, "Socket.IO Redis adapter disconnected; donation batching paused");
      });
    }
  }

  /**
   * Add a single donation to the batch. Schedules a flush if not already scheduled.
   * Flushes early if batch size reaches maxBatchSize.
   *
   * When the accumulator exceeds `maxPendingDonations`, the oldest donations are
   * dropped (with a Prometheus counter increment) to bound memory usage.
   *
   * @param {object} donation - Donation object with projectId, donorAddress, amountXLM, etc.
   */
  addDonation(donation) {
    if (!donation || typeof donation !== "object") {
      throw new Error("addDonation requires a non-null donation object");
    }

    // Graceful degradation: if the Socket.IO Redis adapter is disconnected,
    // stop accumulating to avoid unbounded memory growth.
    if (this._adapterDisconnected) {
      logger.error(
        { event: "donation_batcher_paused", pending: this.donations.length },
        "Donation batcher paused: Socket.IO adapter disconnected",
      );
      return;
    }

    this.donations.push(donation);

    // Backpressure: enforce a hard cap on pending donations. Drop the oldest
    // donations beyond the cap and increment the drop counter.
    if (this.donations.length > this.maxPendingDonations) {
      const overflow = this.donations.length - this.maxPendingDonations;
      this.donations.splice(0, overflow);
      this.totalDropped += overflow;
      donationBatcherDropTotal.inc(overflow);
      logger.warn(
        { event: "donation_batcher_drop", dropped: overflow, pending: this.donations.length },
        `Donation batcher dropped ${overflow} oldest donations due to backpressure`,
      );
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

    const durationSeconds = Number(process.hrtime.bigint() - start) / 1e9;
    donationBatchSize.observe(batch.donations.length);
    donationBatchFlushDurationSeconds.observe(durationSeconds);

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
   * Return observability stats for the batcher.
   * @returns {{pending: number, totalFlushed: number, totalDropped: number}}
   */
  getStats() {
    return {
      pending: this.donations.length,
      totalFlushed: this.totalFlushed,
      totalDropped: this.totalDropped,
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
