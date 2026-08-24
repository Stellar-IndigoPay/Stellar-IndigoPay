"use strict";

jest.mock("../logger", () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));

jest.mock("./lifecycle", () => ({
  onShutdown: jest.fn(),
}));

const logger = require("../logger");
const lifecycle = require("./lifecycle");
const {
  startManagedWorker,
  stopManagedWorker,
  createDrainController,
  getWorkerDrainStates,
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

// Issue #931: shared worker drain state machine (running -> draining ->
// drained), in-flight job tracking, and grace-period-bounded shutdown.
describe("createDrainController", () => {
  function deferred() {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  test("starts running and not draining", () => {
    const drain = createDrainController("test_starts_running");
    expect(drain.getState()).toBe("running");
    expect(drain.isDraining()).toBe(false);
    expect(drain.getInFlightCount()).toBe(0);
  });

  test("trackJob tracks the in-flight count around the job's lifetime", async () => {
    const drain = createDrainController("test_trackJob_count");
    const job = deferred();

    const result = drain.trackJob(() => job.promise);
    // Job hasn't resolved yet — still in flight.
    expect(drain.getInFlightCount()).toBe(1);

    job.resolve("done");
    await expect(result).resolves.toBe("done");
    expect(drain.getInFlightCount()).toBe(0);
  });

  test("trackJob decrements in-flight count even when the job throws", async () => {
    const drain = createDrainController("test_trackJob_throws");
    const err = new Error("job failed");

    await expect(
      drain.trackJob(() => Promise.reject(err)),
    ).rejects.toThrow("job failed");
    expect(drain.getInFlightCount()).toBe(0);
  });

  test("beginDrain resolves immediately and marks drained when nothing is in flight", async () => {
    const drain = createDrainController("test_beginDrain_idle");
    await expect(drain.beginDrain()).resolves.toBe("drained");
    expect(drain.getState()).toBe("drained");
  });

  test("beginDrain moves to draining immediately, then waits for the in-flight job to finish before marking drained", async () => {
    const drain = createDrainController("test_beginDrain_waits");
    const job = deferred();

    const jobPromise = drain.trackJob(() => job.promise);
    const drainPromise = drain.beginDrain();

    // Draining starts synchronously, without waiting for the job.
    expect(drain.getState()).toBe("draining");
    expect(drain.isDraining()).toBe(true);

    // Finish the in-flight job — beginDrain should now settle.
    job.resolve("ok");
    await jobPromise;
    await expect(drainPromise).resolves.toBe("drained");
    expect(drain.getState()).toBe("drained");
  });

  test("beginDrain force-drains after the grace period even if a job never finishes (SIGKILL simulation)", async () => {
    jest.useFakeTimers();
    try {
      const drain = createDrainController("test_beginDrain_grace_expiry", {
        gracePeriodMs: 5_000,
      });
      // A job that never resolves — simulates work that can't be
      // interrupted safely and doesn't finish before the grace window.
      const neverSettles = new Promise(() => {});
      drain.trackJob(() => neverSettles);

      const drainPromise = drain.beginDrain();
      expect(drain.getState()).toBe("draining");

      await jest.advanceTimersByTimeAsync(5_000);

      await expect(drainPromise).resolves.toBe("drained");
      expect(drain.getState()).toBe("drained");
      // The job itself is still "in flight" by the controller's own
      // bookkeeping — force-draining doesn't cancel it, it just stops
      // waiting. Recovery (lease expiry / DLQ / at-least-once redelivery)
      // is the job model's responsibility once the process actually exits.
      expect(drain.getInFlightCount()).toBe(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("getWorkerDrainStates reports state and in-flight count for every registered controller", async () => {
    const a = createDrainController("test_registry_worker_a");
    const b = createDrainController("test_registry_worker_b");
    const job = deferred();
    a.trackJob(() => job.promise);

    const states = getWorkerDrainStates();
    expect(states.test_registry_worker_a).toEqual({
      state: "running",
      inFlight: 1,
    });
    expect(states.test_registry_worker_b).toEqual({
      state: "running",
      inFlight: 0,
    });

    job.resolve();
    await b.beginDrain();
    expect(getWorkerDrainStates().test_registry_worker_b.state).toBe(
      "drained",
    );
  });
});
