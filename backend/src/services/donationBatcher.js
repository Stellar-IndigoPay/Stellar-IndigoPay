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
 * Usage:
 *   const batcher = new DonationBatcher(io, { batchWindowMs: 500 });
 *   batcher.addDonation({ projectId, donorAddress, amountXLM, ... });
 *   // After 500ms of no new donations, or when batch is flushed,
 *   // emits: io.emit("donation_batch", { donations: [...], batchId, timestamp })
 */
"use strict";

const { v4: uuid } = require("uuid");

class DonationBatcher {
  /**
   * @param {import("socket.io").Server} io - Socket.IO server instance for emitting events.
   * @param {{batchWindowMs?: number, maxBatchSize?: number}} [options={}]
   *   - batchWindowMs: milliseconds to wait before flushing (default 500)
   *   - maxBatchSize: max donations per batch; flush early if exceeded (default 50)
   */
  constructor(io, options = {}) {
    this.io = io;
    this.batchWindowMs = options.batchWindowMs ?? 500;
    this.maxBatchSize = options.maxBatchSize ?? 50;

    this.donations = []; // accumulator
    this.batchTimer = null;
    this.isFlushScheduled = false;
  }

  /**
   * Add a single donation to the batch. Schedules a flush if not already scheduled.
   * Flushes early if batch size reaches maxBatchSize.
   *
   * @param {object} donation - Donation object with projectId, donorAddress, amountXLM, etc.
   */
  addDonation(donation) {
    if (!donation || typeof donation !== "object") {
      throw new Error("addDonation requires a non-null donation object");
    }

    this.donations.push(donation);

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

    // Emit the batch to all connected clients
    if (this.io && typeof this.io.emit === "function") {
      this.io.emit("donation_batch", batch);
    }

    // Reset the accumulator
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
   * Replace the Socket.IO instance (useful for testing).
   */
  setIO(io) {
    this.io = io;
  }
}

module.exports = DonationBatcher;
