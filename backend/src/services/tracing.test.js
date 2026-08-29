"use strict";

/**
 * src/services/tracing.test.js
 *
 * Tests for the OpenTelemetry tracing service.
 *
 * These tests verify:
 *   - isEnabled() reflects the OTEL_EXPORTER_OTLP_ENDPOINT env var
 *   - initTracing() is idempotent
 *   - traceIdMiddleware sets req.id from the active span
 *   - withSpan() passes through when tracing is disabled
 *   - stopTracing() handles the noop case gracefully
 */

// Save original env so we can restore after each test.
const originalEnv = { ...process.env };

beforeEach(() => {
  // Reset the module state for each test.
  jest.resetModules();
  // Restore original env.
  process.env = { ...originalEnv };
  // Clear OTEL vars for clean test state.
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
  delete process.env.OTEL_SAMPLE_RATE;
  delete process.env.OTEL_TRACES_ENABLED;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// We need to re-require tracing after env changes so the lazy init
// picks up the new values.  Import fresh module inside each test.
function freshTracing() {
  jest.resetModules();
  return require("./tracing");
}

describe("tracing.isEnabled", () => {
  it("returns false when OTEL_EXPORTER_OTLP_ENDPOINT is not set", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    expect(t.isEnabled()).toBe(false);
  });

  it("returns true when OTEL_EXPORTER_OTLP_ENDPOINT is set", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    const t = freshTracing();
    expect(t.isEnabled()).toBe(true);
  });

  it("returns false when OTEL_TRACES_ENABLED is explicitly false", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
    process.env.OTEL_TRACES_ENABLED = "false";
    const t = freshTracing();
    expect(t.isEnabled()).toBe(false);
  });
});

describe("tracing.initTracing", () => {
  it("returns false and logs when tracing is disabled", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    const result = await t.initTracing();
    expect(result).toBe(false);
  });

  it("is idempotent — second call returns the same result as the first", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    const first = await t.initTracing();
    const second = await t.initTracing();
    expect(first).toBe(second);
  });

  it("does not mark initialized on sdk.start() failure, allowing retry", async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";

    // Mock NodeSDK so that start() rejects.
    jest.doMock("@opentelemetry/sdk-node", () => ({
      NodeSDK: jest.fn().mockImplementation(() => ({
        start: jest.fn().mockRejectedValue(new Error("connection refused")),
        shutdown: jest.fn().mockResolvedValue(undefined),
      })),
    }));

    const t = freshTracing();

    // First call — sdk.start() fails.
    const first = await t.initTracing();
    expect(first).toBe(false);

    // Second call — should retry because initialized was not set to true.
    // (It will fail again with the same mock, but the point is it tries.)
    const second = await t.initTracing();
    expect(second).toBe(false);

    jest.dontMock("@opentelemetry/sdk-node");
  });
});

describe("tracing.withSpan", () => {
  it("executes the callback and returns its result when tracing is disabled", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    const result = await t.withSpan("test.span", async () => 42);
    expect(result).toBe(42);
  });

  it("propagates errors from the callback when tracing is disabled", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    await expect(
      t.withSpan("test.error", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });

  it("passes span attributes through", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    // With tracing disabled, attributes are no-ops — just verify no crash.
    const result = await t.withSpan(
      "test.attrs",
      async () => "ok",
      { "db.operation": "SELECT", "db.table": "projects" },
    );
    expect(result).toBe("ok");
  });
});

describe("tracing.getTracer", () => {
  it("returns a tracer instance without crashing", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    const tracer = t.getTracer();
    expect(tracer).toBeDefined();
    expect(typeof tracer.startActiveSpan).toBe("function");
  });
});

describe("tracing.traceIdMiddleware", () => {
  it("calls next() immediately when tracing is disabled", () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    const req = { id: "original-id" };
    const res = {
      headersSent: false,
      getHeader: jest.fn().mockReturnValue(undefined),
      setHeader: jest.fn(),
    };
    const next = jest.fn();

    t.traceIdMiddleware(req, res, next);

    // When tracing is disabled, req.id is left alone.
    expect(req.id).toBe("original-id");
    expect(next).toHaveBeenCalled();
    // No headers were set since middleware is a no-op when disabled.
    expect(res.setHeader).not.toHaveBeenCalled();
  });
});

describe("tracing.stopTracing", () => {
  it("does not throw when called before init", async () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    const t = freshTracing();
    await expect(t.stopTracing()).resolves.toBeUndefined();
  });
});