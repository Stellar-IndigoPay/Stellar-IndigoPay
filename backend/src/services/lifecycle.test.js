"use strict";

const lifecycle = require("./lifecycle");

describe("lifecycle service", () => {
  beforeEach(() => {
    lifecycle._resetForTests();
  });

  test("isShuttingDown is false by default", () => {
    expect(lifecycle.isShuttingDown()).toBe(false);
  });

  test("beginShutdown flips the flag to true", () => {
    lifecycle.beginShutdown();
    expect(lifecycle.isShuttingDown()).toBe(true);
  });

  test("onShutdown registers a handler that is invoked by runShutdownHandlers", async () => {
    const fn = jest.fn().mockResolvedValue(undefined);
    lifecycle.onShutdown(fn);
    await lifecycle.runShutdownHandlers();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("runShutdownHandlers invokes handlers in registration order", async () => {
    const order = [];
    lifecycle.onShutdown(() => { order.push("a"); return Promise.resolve(); });
    lifecycle.onShutdown(() => { order.push("b"); return Promise.resolve(); });
    lifecycle.onShutdown(() => { order.push("c"); return Promise.resolve(); });
    await lifecycle.runShutdownHandlers();
    expect(order).toEqual(["a", "b", "c"]);
  });

  test("runShutdownHandlers continues past a throwing handler", async () => {
    const order = [];
    const origError = console.error;
    console.error = jest.fn();
    try {
      lifecycle.onShutdown(() => { order.push("a"); });
      lifecycle.onShutdown(() => { order.push("b"); throw new Error("boom"); });
      lifecycle.onShutdown(() => { order.push("c"); });
      await lifecycle.runShutdownHandlers();
      expect(order).toEqual(["a", "b", "c"]);
    } finally {
      console.error = origError;
    }
  });

  test("onShutdown ignores non-function arguments", async () => {
    lifecycle.onShutdown(null);
    lifecycle.onShutdown("not a function");
    lifecycle.onShutdown(42);
    await expect(lifecycle.runShutdownHandlers()).resolves.toBeUndefined();
  });

  test("onShutdown awaits async handlers", async () => {
    let resolved = false;
    lifecycle.onShutdown(async () => {
      await new Promise((r) => setTimeout(r, 5));
      resolved = true;
    });
    await lifecycle.runShutdownHandlers();
    expect(resolved).toBe(true);
  });
});
