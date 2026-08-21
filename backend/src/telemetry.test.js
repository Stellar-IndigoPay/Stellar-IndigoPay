"use strict";

const { SimpleSpanProcessor, InMemorySpanExporter } = require("@opentelemetry/sdk-trace-base");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");

describe("donation trace pipeline", () => {
  let exporter;
  beforeAll(() => {
    exporter = new InMemorySpanExporter();
    new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] }).register();
  });
  afterEach(() => exporter.reset());

  test("seeded donation preserves API → queue → worker trace id", async () => {
    jest.resetModules();
    const { contextFromJob, injectTraceMetadata, withSpan } = require("./telemetry");
    await withSpan("HTTP request", { "http.route": "/api/donations", payload: "must-not-export" }, async (api) => {
      await withSpan("donation queue", { "messaging.destination.name": "donations" }, async () => {
        const job = injectTraceMetadata({ donationId: "seed-donation" });
        expect(job.metadata.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-0[01]$/);
        expect(job.metadata).not.toHaveProperty("donationId");
        await withSpan("donation worker", { "worker.name": "indexer" }, async () => {}, contextFromJob(job));
      });
      expect(api.spanContext().traceId).toHaveLength(32);
    });
    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual(expect.arrayContaining(["HTTP request", "donation queue", "donation worker"]));
    expect(new Set(spans.map((span) => span.spanContext().traceId)).size).toBe(1);
    const queue = spans.find((span) => span.name === "donation queue");
    const worker = spans.find((span) => span.name === "donation worker");
    expect(worker.parentSpanContext.spanId).toBe(queue.spanContext().spanId);
    expect(spans.flatMap((span) => Object.keys(span.attributes))).not.toContain("payload");
  });

  test("only allowlisted attributes are exported", () => {
    const { safeAttributes } = require("./telemetry");
    expect(safeAttributes({ "worker.name": "webhook", email: "pii@example.test", "db.statement": "secret" }))
      .toEqual({ "worker.name": "webhook" });
  });
});
