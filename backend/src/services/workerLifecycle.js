"use strict";

const logger = require("../logger");
const lifecycle = require("./lifecycle");

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

module.exports = { startManagedWorker, stopManagedWorker };
