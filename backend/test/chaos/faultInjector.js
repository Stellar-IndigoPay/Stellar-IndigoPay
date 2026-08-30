"use strict";

/**
 * backend/test/chaos/faultInjector.js
 *
 * Fault-injection layer for the worker chaos harness.
 *
 * SAFETY: This module is TEST-ONLY. It is a no-op unless the environment
 * variable CHAOS_TEST=1 is set. Production deployments never set this flag.
 *
 * The injector wraps a real `pg.Pool`-compatible object and intercepts
 * individual `query()` calls at scripted crash points in the job lifecycle:
 *
 *   CrashPoint.AFTER_CLAIM      — query succeeds, then process throws (simulates
 *                                  kill -9 after the worker claimed the job row)
 *   CrashPoint.MID_COMMIT       — throws mid-way through a DB-persisted write
 *                                  (partial commit: state row written, queue ack
 *                                  not yet sent)
 *   CrashPoint.AFTER_ENQUEUE    — throws after a new job has been enqueued but
 *                                  before the caller's own commit / ack
 *   CrashPoint.QUEUE_UNAVAILABLE — every boss.send / boss.work call rejects
 *                                  (simulates queue store outage)
 *
 * Usage:
 *
 *   const { FaultInjector, CrashPoint } = require('./faultInjector');
 *   const injector = new FaultInjector(realPool);
 *   injector.armAt(CrashPoint.AFTER_CLAIM, { afterQuery: /UPDATE.*claim/ });
 *   // …run worker…
 *   injector.disarm();
 */

const { CHAOS_TEST } = process.env;

/** Named crash-point constants so tests read clearly. */
const CrashPoint = Object.freeze({
  AFTER_CLAIM: "AFTER_CLAIM",
  MID_COMMIT: "MID_COMMIT",
  AFTER_ENQUEUE: "AFTER_ENQUEUE",
  QUEUE_UNAVAILABLE: "QUEUE_UNAVAILABLE",
});

/**
 * A thin wrapper around `pg.Pool` that intercepts queries and throws
 * deterministically at configured crash points.
 *
 * All interception is disabled (pass-through) unless `CHAOS_TEST=1`.
 */
class FaultInjector {
  /**
   * @param {object} realPool  Real `pg.Pool` instance (or a compatible fake).
   */
  constructor(realPool) {
    if (!CHAOS_TEST) {
      throw new Error(
        "FaultInjector must only be used when CHAOS_TEST=1. " +
          "Never enable chaos injection outside the test suite.",
      );
    }

    this._pool = realPool;
    this._armed = false;
    this._point = null;
    this._matchPattern = null;   // RegExp | null  — if set, only fire on matching SQL
    this._queryCount = 0;        // total queries seen
    this._firedCount = 0;        // how many times the fault fired

    // Proxy the pool so callers use `injector` as a drop-in pool replacement.
    this.query = this._query.bind(this);
    this.connect = this._connect.bind(this);
    this.end = this._end.bind(this);
  }

  /**
   * Arm the injector at a given crash point.
   *
   * @param {string} point     One of the CrashPoint constants.
   * @param {object} [options]
   * @param {RegExp} [options.afterQuery]  Only fire after a query whose text
   *   matches this pattern (useful for precise lifecycle scripting).
   * @param {number} [options.fireOnNth]   Fire only on the N-th matching call.
   *   Default: fire every time.
   */
  armAt(point, options = {}) {
    if (!CrashPoint[point]) {
      throw new Error(`Unknown crash point: ${point}`);
    }
    this._armed = true;
    this._point = point;
    this._matchPattern = options.afterQuery || null;
    this._fireOnNth = options.fireOnNth || null;
    this._queryCount = 0;
    this._firedCount = 0;
    return this;
  }

  /** Disarm — subsequent queries pass through without interference. */
  disarm() {
    this._armed = false;
    this._point = null;
    this._matchPattern = null;
    this._fireOnNth = null;
    return this;
  }

  /** How many times the fault has actually fired since the last armAt(). */
  get firedCount() {
    return this._firedCount;
  }

  // ─── Internal ────────────────────────────────────────────────────────────

  async _query(text, params) {
    this._queryCount++;

    // Execute the real query first (so the DB write happens — we're simulating
    // a process crash *after* the write, not a DB-level failure).
    const result = await this._pool.query(text, params);

    if (this._armed && this._point !== CrashPoint.QUEUE_UNAVAILABLE) {
      const matchesPattern =
        !this._matchPattern || this._matchPattern.test(text);
      const shouldFireOnNth =
        !this._fireOnNth || this._queryCount === this._fireOnNth;

      if (matchesPattern && shouldFireOnNth) {
        this._firedCount++;
        const err = new FaultInjectionError(
          `[FaultInjector] Simulated crash at ${this._point} ` +
            `(query #${this._queryCount})`,
          this._point,
        );
        throw err;
      }
    }

    return result;
  }

  async _connect() {
    const client = await this._pool.connect();
    // Wrap the client's query method as well so transaction-wrapped
    // queries go through fault injection.
    const origQuery = client.query.bind(client);
    client.query = async (text, params) => {
      this._queryCount++;
      const result = await origQuery(text, params);
      if (
        this._armed &&
        this._point !== CrashPoint.QUEUE_UNAVAILABLE
      ) {
        const matchesPattern =
          !this._matchPattern || this._matchPattern.test(text);
        const shouldFireOnNth =
          !this._fireOnNth || this._queryCount === this._fireOnNth;

        if (matchesPattern && shouldFireOnNth) {
          this._firedCount++;
          throw new FaultInjectionError(
            `[FaultInjector] Simulated crash at ${this._point}`,
            this._point,
          );
        }
      }
      return result;
    };
    return client;
  }

  async _end() {
    return this._pool.end();
  }
}

/**
 * Wrap a pg-boss-compatible boss object so that `send` / `work` calls throw
 * when QUEUE_UNAVAILABLE is armed on the provided injector.
 *
 * @param {object} boss         Real or fake pg-boss instance.
 * @param {FaultInjector} injector  Must be armed at QUEUE_UNAVAILABLE.
 * @returns {object} Proxy boss whose send/work throw when armed.
 */
function wrapBossWithQueueFault(boss, injector) {
  return new Proxy(boss, {
    get(target, prop) {
      if (
        injector._armed &&
        injector._point === CrashPoint.QUEUE_UNAVAILABLE &&
        (prop === "send" || prop === "work" || prop === "fetch")
      ) {
        return async (...args) => {
          injector._firedCount++;
          throw new FaultInjectionError(
            "[FaultInjector] Simulated queue store outage",
            CrashPoint.QUEUE_UNAVAILABLE,
          );
        };
      }
      const val = target[prop];
      return typeof val === "function" ? val.bind(target) : val;
    },
  });
}

/**
 * A distinctive error class so tests can assert on the fault specifically
 * without accidentally catching real DB errors.
 */
class FaultInjectionError extends Error {
  /**
   * @param {string} message
   * @param {string} crashPoint  One of the CrashPoint constants.
   */
  constructor(message, crashPoint) {
    super(message);
    this.name = "FaultInjectionError";
    this.crashPoint = crashPoint;
  }
}

module.exports = {
  CrashPoint,
  FaultInjector,
  FaultInjectionError,
  wrapBossWithQueueFault,
};
