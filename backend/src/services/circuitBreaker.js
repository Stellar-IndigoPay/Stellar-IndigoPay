/**
 * src/services/circuitBreaker.js
 *
 * Reusable circuit breaker utility for the Stellar IndigoPay backend.
 *
 * States
 * ------
 *  CLOSED    – Normal operation. All calls pass through.
 *  OPEN      – Too many consecutive failures. Calls are rejected immediately
 *              without invoking the underlying function, giving the downstream
 *              time to recover.
 *  HALF_OPEN – The reset timeout has elapsed. The next call is attempted; on
 *              success the breaker transitions back to CLOSED; on failure it
 *              goes back to OPEN and resets the last-failure timer.
 *
 * Prometheus
 * ----------
 * Exports a `circuitBreakerGauge` Gauge keyed by `name` that encodes the
 * current state as an integer:
 *   0 = closed  (healthy)
 *   1 = half_open
 *   2 = open    (circuit tripped)
 *
 * Usage
 * -----
 *   const { CircuitBreaker } = require('./circuitBreaker');
 *   const breaker = new CircuitBreaker({ name: 'soroban_rpc', failureThreshold: 5, resetTimeout: 30_000 });
 *   const result = await breaker.call(() => rpcServer.sendTransaction(xdr));
 */
"use strict";

const logger = require("../logger");
const { Gauge } = require("prom-client");
const { registry } = require("./metrics");

/** @enum {string} */
const STATES = Object.freeze({
  CLOSED: "closed",
  OPEN: "open",
  HALF_OPEN: "half_open",
});

/** Numeric encoding for the Prometheus gauge. */
const STATE_VALUES = {
  [STATES.CLOSED]: 0,
  [STATES.HALF_OPEN]: 1,
  [STATES.OPEN]: 2,
};

/**
 * Prometheus gauge tracking circuit breaker state per named breaker.
 * Registered on the shared registry so it appears at /metrics automatically.
 */
const circuitBreakerGauge = new Gauge({
  name: "indigopay_soroban_circuit_breaker_state",
  help: "Circuit breaker state: 0=closed (healthy), 1=half_open, 2=open (tripped)",
  labelNames: ["name"],
  registers: [registry],
});

class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {string}  [opts.name='default']          Label shown in Prometheus and logs.
   * @param {number}  [opts.failureThreshold=5]      Consecutive failures before opening.
   * @param {number}  [opts.resetTimeout=30_000]     Ms to wait before attempting half-open.
   */
  constructor(opts = {}) {
    this.name = opts.name || "default";
    this.failureThreshold = opts.failureThreshold || 5;
    this.resetTimeout = opts.resetTimeout || 30_000;

    this.state = STATES.CLOSED;
    this.failureCount = 0;
    this.lastFailureTime = null;

    // Initialise gauge to 0 (closed).
    circuitBreakerGauge.set({ name: this.name }, STATE_VALUES[STATES.CLOSED]);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Execute `fn` through the circuit breaker.
   *
   * @param {Function} fn  Async (or sync) function to call.
   * @returns {Promise<*>} Resolves with whatever `fn` resolves with.
   * @throws  {Error}      Re-throws errors from `fn`, or throws immediately when
   *                       the circuit is open and the reset window hasn't elapsed.
   */
  async call(fn) {
    if (this.state === STATES.OPEN) {
      const elapsed = Date.now() - this.lastFailureTime;
      if (elapsed > this.resetTimeout) {
        this._transition(STATES.HALF_OPEN);
        logger.info(
          { event: "circuit_breaker_half_open", breaker: this.name, elapsed },
          `Circuit breaker [${this.name}] entering HALF_OPEN after ${elapsed}ms`,
        );
      } else {
        throw new Error(
          `Circuit breaker [${this.name}] is OPEN — requests blocked for ${Math.ceil((this.resetTimeout - elapsed) / 1000)}s`,
        );
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  /**
   * Current state string ("closed" | "open" | "half_open").
   * Useful for health checks and tests.
   */
  getState() {
    return this.state;
  }

  /**
   * Current consecutive failure count.
   */
  getFailureCount() {
    return this.failureCount;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _onSuccess() {
    if (this.state !== STATES.CLOSED) {
      logger.info(
        { event: "circuit_breaker_closed", breaker: this.name },
        `Circuit breaker [${this.name}] recovered — transitioning to CLOSED`,
      );
    }
    this.failureCount = 0;
    this.lastFailureTime = null;
    this._transition(STATES.CLOSED);
  }

  _onFailure(err) {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this._transition(STATES.OPEN);
      logger.error(
        {
          event: "circuit_breaker_open",
          breaker: this.name,
          failures: this.failureCount,
          err: err.message,
        },
        `Circuit breaker [${this.name}] tripped after ${this.failureCount} failures`,
      );
    } else {
      logger.warn(
        {
          event: "circuit_breaker_failure",
          breaker: this.name,
          failures: this.failureCount,
          threshold: this.failureThreshold,
          err: err.message,
        },
        `Circuit breaker [${this.name}] failure ${this.failureCount}/${this.failureThreshold}`,
      );
    }
  }

  _transition(newState) {
    this.state = newState;
    circuitBreakerGauge.set({ name: this.name }, STATE_VALUES[newState]);
  }
}

module.exports = { CircuitBreaker, circuitBreakerGauge, STATES };
