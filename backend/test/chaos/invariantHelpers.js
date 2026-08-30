"use strict";

/**
 * backend/test/chaos/invariantHelpers.js
 *
 * Assertion helpers for the chaos harness invariants.
 *
 * Each helper is concerned with one recovery invariant:
 *
 *   assertNoLoss(seen, expected)        — nothing permanently lost
 *   assertNoDuplicates(seen)            — no job processed twice (without
 *                                         idempotent dedupe)
 *   assertAtLeastOnce(seen, expected)   — each id processed at least once
 *   assertSingleProcessing(seen, id)    — exactly one processing of a given id
 *
 * Counting consumers (FakeConsumer) instrument the worker under test and
 * record every job-id they process, including how many times each id
 * was seen. This lets tests remove the idempotency guard and assert
 * the duplicate-detection assertion *fails* (acceptance criterion: "a
 * deliberately removed idempotency guard fails the duplicate-detection
 * assertion").
 */

/**
 * A fake consumer/service that records every processed job id.
 * Pass `onProcess` to the worker under test in place of the real handler.
 */
class FakeConsumer {
  constructor() {
    /** @type {Map<string, number>}  id → times processed */
    this._counts = new Map();
    /** @type {string[]}  ordered log of all seen ids */
    this._log = [];
    /** @type {Error[]}   any errors thrown during processing */
    this._errors = [];
  }

  /**
   * Record that `id` was processed.
   * Call this from the worker handler shim.
   */
  record(id) {
    const n = (this._counts.get(id) || 0) + 1;
    this._counts.set(id, n);
    this._log.push(id);
  }

  /** Record an error that occurred during a processing attempt. */
  recordError(err) {
    this._errors.push(err);
  }

  /** Total number of processing calls (all ids, all repeats). */
  get totalCalls() {
    return this._log.length;
  }

  /** Number of *unique* job ids seen. */
  get uniqueCount() {
    return this._counts.size;
  }

  /** Ids that were processed more than once. */
  get duplicates() {
    return [...this._counts.entries()]
      .filter(([, n]) => n > 1)
      .map(([id, n]) => ({ id, count: n }));
  }

  /** True if any id was processed more than once. */
  get hasDuplicates() {
    return this.duplicates.length > 0;
  }

  /** All recorded processing errors. */
  get errors() {
    return this._errors.slice();
  }

  /** How many times `id` was processed. */
  countFor(id) {
    return this._counts.get(id) || 0;
  }

  /** Whether `id` was processed at all. */
  sawId(id) {
    return this._counts.has(id);
  }

  /** Reset state between scenarios. */
  reset() {
    this._counts.clear();
    this._log = [];
    this._errors = [];
  }
}

// ─── Assertion helpers ──────────────────────────────────────────────────────

/**
 * Assert that every id in `expected` was processed at least once.
 * Throws with a descriptive message listing the lost ids.
 *
 * @param {FakeConsumer} consumer
 * @param {string[]}     expected  All job ids that must have been processed.
 */
function assertNoLoss(consumer, expected) {
  const lost = expected.filter((id) => !consumer.sawId(id));
  if (lost.length > 0) {
    throw new Error(
      `assertNoLoss FAILED — ${lost.length} job(s) permanently lost:\n` +
        lost.map((id) => `  • ${id}`).join("\n"),
    );
  }
}

/**
 * Assert that no id was processed more than once.
 * Throws with a descriptive message listing the duplicates.
 *
 * NOTE: This assertion is *expected to fail* when the idempotency guard is
 * deliberately removed, which is part of the acceptance criteria.
 *
 * @param {FakeConsumer} consumer
 */
function assertNoDuplicates(consumer) {
  if (consumer.hasDuplicates) {
    const lines = consumer.duplicates.map(
      ({ id, count }) => `  • ${id} processed ${count}× (expected 1×)`,
    );
    throw new Error(
      `assertNoDuplicates FAILED — ${consumer.duplicates.length} job(s) processed multiple times:\n` +
        lines.join("\n"),
    );
  }
}

/**
 * Assert that each id in `expected` was processed at least once
 * (alias for assertNoLoss, provided for readability at call-sites).
 */
const assertAtLeastOnce = assertNoLoss;

/**
 * Assert that `id` was processed exactly once — no loss and no duplicate.
 *
 * @param {FakeConsumer} consumer
 * @param {string}       id
 */
function assertSingleProcessing(consumer, id) {
  const n = consumer.countFor(id);
  if (n !== 1) {
    throw new Error(
      `assertSingleProcessing FAILED — expected ${id} to be processed exactly once, ` +
        `but it was processed ${n}× (${n === 0 ? "lost" : "duplicated"})`,
    );
  }
}

/**
 * Assert that two recovery mechanisms that raced on the same stranded job
 * resulted in exactly one processing of that job.
 *
 * @param {FakeConsumer} consumer
 * @param {string}       jobId
 * @param {string[]}     recoveryPaths  Labels for the two racing paths (for
 *                                      error messages only).
 */
function assertRaceConvergesToSingle(consumer, jobId, recoveryPaths = []) {
  const n = consumer.countFor(jobId);
  if (n === 0) {
    throw new Error(
      `assertRaceConvergesToSingle FAILED — job ${jobId} was never processed ` +
        `(recovery paths: ${recoveryPaths.join(", ") || "unknown"})`,
    );
  }
  if (n > 1) {
    throw new Error(
      `assertRaceConvergesToSingle FAILED — job ${jobId} was processed ${n}× ` +
        `by racing recovery paths (expected exactly 1). ` +
        `Paths: ${recoveryPaths.join(", ") || "unknown"}`,
    );
  }
}

module.exports = {
  FakeConsumer,
  assertNoLoss,
  assertNoDuplicates,
  assertAtLeastOnce,
  assertSingleProcessing,
  assertRaceConvergesToSingle,
};
