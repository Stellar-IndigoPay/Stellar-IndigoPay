/**
 * src/services/lifecycle.js
 *
 * Process-wide lifecycle state. We need a single source of truth for
 * "are we shutting down?" so that the health and readiness probes
 * start returning 503 the moment SIGTERM is received — K8s will then
 * stop sending new traffic and we can drain in-flight requests
 * cleanly.
 *
 * Keeping this in a dedicated module also means unit tests can flip
 * the flag without reaching for a real SIGTERM.
 */
"use strict";

let shuttingDown = false;
const shutdownHandlers = [];

function isShuttingDown() {
  return shuttingDown;
}

function beginShutdown() {
  shuttingDown = true;
}

/**
 * Register a callback to run during graceful shutdown. Handlers run
 * in registration order. If a handler throws, the error is logged
 * and the next handler still runs.
 */
function onShutdown(fn) {
  if (typeof fn === "function") {
    shutdownHandlers.push(fn);
  }
}

async function runShutdownHandlers() {
  for (const fn of shutdownHandlers) {
    try {
      await fn();
    } catch (err) {
      // Don't let one bad handler stop the others.
      // eslint-disable-next-line no-console
      console.error("[lifecycle] shutdown handler failed:", err.message);
    }
  }
}

// Test-only: reset the flag. NOT exported via the public surface.
function _resetForTests() {
  shuttingDown = false;
  shutdownHandlers.length = 0;
}

module.exports = {
  beginShutdown,
  isShuttingDown,
  onShutdown,
  runShutdownHandlers,
  _resetForTests,
};
