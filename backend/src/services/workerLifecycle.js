"use strict";

const logger = require("../logger");
const lifecycle = require("./lifecycle");
const { metrics } = require("./metrics");

// Default grace window a worker gets to finish in-flight jobs before
// `beginDrain()` gives up waiting and lets shutdown proceed anyway. The
// pod-level termination grace period (see the PDB / SHUTDOWN_TIMEOUT_MS
// config) must be >= this value or the process gets SIGKILLed mid-drain.
const DEFAULT_GRACE_PERIOD_MS = Number(
  process.env.WORKER_DRAIN_GRACE_MS || 30_000,
);

// Registry of every drain controller created in this process, so the
// readiness probe (or an admin endpoint) can report drain state per
// worker without each caller having to wire that up itself.
const drainControllers = new Map();

/**
 * Create a shutdown-drain state machine for a single worker.
 *
 * States: running -> draining -> drained (terminal for this instance).
 * `trackJob(fn)` wraps a unit of work so the controller knows how many
 * jobs are currently in flight; `beginDrain()` stops treating the worker
 * as running, waits (up to `gracePeriodMs`) for the in-flight count to
 * reach zero, then marks the worker drained. Callers remain responsible
 * for actually stopping new claims (clearing an interval, letting a
 * queue library's own graceful stop take over, closing a stream, etc.) —
 * this controller only tracks state and waits, it does not intercept
 * claiming.
 */
function createDrainController(name, { gracePeriodMs = DEFAULT_GRACE_PERIOD_MS } = {}) {
  let state = "running";
  let inFlight = 0;
  let waiters = [];

  function setDrainGauge(value) {
    try {
      metrics.workerDraining?.set({ worker: name }, value);
    } catch {
      // Metric may not be registered in a minimal test environment.
    }
  }

  function getState() {
    return state;
  }

  function isDraining() {
    return state !== "running";
  }

  function getInFlightCount() {
    return inFlight;
  }

  function notifyIdle() {
    if (inFlight === 0 && waiters.length) {
      const pending = waiters;
      waiters = [];
      for (const resolve of pending) resolve();
    }
  }

  /**
   * Run `fn` as a tracked unit of in-flight work. Always call this
   * around the job body a worker executes so `beginDrain()` knows
   * whether it's safe to exit.
   */
  async function trackJob(fn) {
    inFlight += 1;
    try {
      return await fn();
    } finally {
      inFlight -= 1;
      notifyIdle();
    }
  }

  /**
   * Begin draining: stop being "running", wait up to `gracePeriodMs` for
   * any tracked in-flight job(s) to finish, then mark drained. Safe to
   * call even if nothing is in flight (resolves immediately). Idempotent
   * — a second call while already draining just re-waits on the current
   * in-flight count.
   */
  async function beginDrain() {
    if (state === "running") {
      state = "draining";
      setDrainGauge(1);
    }

    if (inFlight > 0) {
      await new Promise((resolve) => {
        let settled = false;
        let timer;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        waiters.push(finish);
        timer = setTimeout(() => {
          logger.warn(
            {
              event: `${name}_drain_grace_expired`,
              worker: name,
              inFlight,
              gracePeriodMs,
            },
            `${name}: drain grace period expired with ${inFlight} job(s) still in flight`,
          );
          finish();
        }, gracePeriodMs);
        if (typeof timer.unref === "function") timer.unref();
      });
    }

    state = "drained";
    setDrainGauge(0);
    return state;
  }

  const controller = {
    trackJob,
    beginDrain,
    getState,
    isDraining,
    getInFlightCount,
  };
  drainControllers.set(name, controller);
  return controller;
}

/**
 * Snapshot of every worker's drain state, keyed by worker name. Used by
 * the readiness probe and admin diagnostics.
 */
function getWorkerDrainStates() {
  const out = {};
  for (const [name, controller] of drainControllers) {
    out[name] = {
      state: controller.getState(),
      inFlight: controller.getInFlightCount(),
    };
  }
  return out;
}

async function stopManagedWorker({ name, label, stop }) {
  try {
    await stop();
    logger.info({ event: `${name}_stopped` }, `${label} stopped`);
  } catch (err) {
    logger.error(
      { event: `${name}_shutdown_error`, err: err.message },
      `${label} failed to stop`,
    );
  }
}

async function startManagedWorker({ name, label, start, stop }) {
  let result;
  try {
    result = await start();
  } catch (err) {
    logger.error(
      { event: `${name}_startup_error`, err: err.message },
      `${label} failed to start`,
    );
    throw err;
  }

  if (result === false) return false;

  logger.info({ event: `${name}_started` }, `${label} started`);

  if (typeof stop === "function") {
    lifecycle.onShutdown(() =>
      stopManagedWorker({ name, label, stop }),
    );
  }

  return true;
}

module.exports = {
  startManagedWorker,
  stopManagedWorker,
  createDrainController,
  getWorkerDrainStates,
};
