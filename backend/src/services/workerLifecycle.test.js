"use strict";

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock("./lifecycle", () => ({
  onShutdown: jest.fn(),
}));

const logger = require("../logger");
const lifecycle = require("./lifecycle");
const {
  startManagedWorker,
  stopManagedWorker,
} = require("./workerLifecycle");

describe("worker lifecycle logging", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("logs startup and registers a shutdown handler", async () => {
    const start = jest.fn().mockResolvedValue(undefined);
    const stop = jest.fn().mockResolvedValue(undefined);

    await expect(
      startManagedWorker({
        name: "example_worker",
        label: "Example worker",
        start,
        stop,
      }),
    ).resolves.toBe(true);

    expect(logger.info).toHaveBeenCalledWith(
      { event: "example_worker_started" },
      "Example worker started",
    );
    expect(lifecycle.onShutdown).toHaveBeenCalledWith(expect.any(Function));

    await lifecycle.onShutdown.mock.calls[0][0]();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledWith(
      { event: "example_worker_stopped" },
      "Example worker stopped",
    );
  });

  test("logs a structured startup error and rethrows it", async () => {
    const error = new Error("cannot connect");

    await expect(
      startManagedWorker({
        name: "example_worker",
        label: "Example worker",
        start: jest.fn().mockRejectedValue(error),
      }),
    ).rejects.toThrow("cannot connect");

    expect(logger.error).toHaveBeenCalledWith(
      {
        event: "example_worker_startup_error",
        err: "cannot connect",
      },
      "Example worker failed to start",
    );
    expect(lifecycle.onShutdown).not.toHaveBeenCalled();
  });

  test("does not log started or register shutdown when disabled", async () => {
    await expect(
      startManagedWorker({
        name: "example_worker",
        label: "Example worker",
        start: jest.fn().mockResolvedValue(false),
        stop: jest.fn(),
      }),
    ).resolves.toBe(false);

    expect(logger.info).not.toHaveBeenCalled();
    expect(lifecycle.onShutdown).not.toHaveBeenCalled();
  });

  test("logs a structured shutdown error without throwing", async () => {
    await expect(
      stopManagedWorker({
        name: "example_worker",
        label: "Example worker",
        stop: jest.fn().mockRejectedValue(new Error("drain timed out")),
      }),
    ).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalledWith(
      {
        event: "example_worker_shutdown_error",
        err: "drain timed out",
      },
      "Example worker failed to stop",
    );
  });
});
