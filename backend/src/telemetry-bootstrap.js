"use strict";

const { BatchSpanProcessor, ParentBasedSampler, SamplingDecision, TraceIdRatioBasedSampler } = require("@opentelemetry/sdk-trace-base");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { OTLPTraceExporter } = require("@opentelemetry/exporter-trace-otlp-http");
const { resourceFromAttributes } = require("@opentelemetry/resources");

let provider;

function boundedRatio(value) {
  const ratio = Number(value);
  return Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0.1;
}

function rootSampler(apiRatio) {
  const apiSampler = new TraceIdRatioBasedSampler(boundedRatio(apiRatio));
  return {
    shouldSample(ctx, traceId, spanName, spanKind, attributes, links) {
      if (attributes && attributes["worker.name"]) {
        return { decision: SamplingDecision.RECORD_AND_SAMPLED };
      }
      return apiSampler.shouldSample(ctx, traceId, spanName, spanKind, attributes, links);
    },
    toString: () => `WorkerAlwaysOnApiRatio(${boundedRatio(apiRatio)})`,
  };
}

function startTelemetry(options = {}) {
  if (provider || process.env.OTEL_SDK_DISABLED === "true") return provider;
  const exporter = options.exporter || new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT || "http://otel-collector:4318/v1/traces",
  });
  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      "service.name": process.env.OTEL_SERVICE_NAME || "stellar-indigopay-backend",
      "deployment.environment.name": process.env.DEPLOYMENT_ENVIRONMENT || process.env.NODE_ENV || "development",
    }),
    sampler: new ParentBasedSampler({ root: rootSampler(process.env.OTEL_API_SAMPLE_RATIO || 0.1) }),
    spanProcessors: [new BatchSpanProcessor(exporter, {
      maxQueueSize: Number(process.env.OTEL_BSP_MAX_QUEUE_SIZE || 2048),
      maxExportBatchSize: Number(process.env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE || 512),
      scheduledDelayMillis: Number(process.env.OTEL_BSP_SCHEDULE_DELAY || 5000),
    })],
  });
  provider.register();
  return provider;
}

async function stopTelemetry() {
  if (provider) await provider.shutdown();
  provider = undefined;
}

module.exports = { boundedRatio, rootSampler, startTelemetry, stopTelemetry };
