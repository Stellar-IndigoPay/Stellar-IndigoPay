"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

describe("HPA and Prometheus Adapter Manifest Validation (Issue #700)", () => {
  const rootDir = path.resolve(__dirname, "../..");
  const hpaPath = path.join(rootDir, "k8s/hpa-backend.yaml");
  const adapterConfigPath = path.join(rootDir, "k8s/prometheus-adapter-configmap.yaml");
  const valuesPath = path.join(rootDir, "helm/indigopay/values.yaml");

  test("k8s/hpa-backend.yaml is valid YAML and includes custom and resource fallback metrics", () => {
    const fileContent = fs.readFileSync(hpaPath, "utf8");
    const doc = yaml.load(fileContent);

    expect(doc.apiVersion).toBe("autoscaling/v2");
    expect(doc.kind).toBe("HorizontalPodAutoscaler");
    expect(doc.metadata.name).toBe("backend");

    const metrics = doc.spec.metrics;
    expect(Array.isArray(metrics)).toBe(true);
    expect(metrics.length).toBeGreaterThanOrEqual(4);

    const externalMetrics = metrics.filter((m) => m.type === "External");
    const resourceMetrics = metrics.filter((m) => m.type === "Resource");

    expect(externalMetrics.length).toBeGreaterThanOrEqual(2);
    expect(resourceMetrics.length).toBeGreaterThanOrEqual(2);

    const metricNames = externalMetrics.map((m) => m.external.metric.name);
    expect(metricNames).toContain("queue_depth");
    expect(metricNames).toContain("indexer_lag_seconds");

    const indexerLagMetric = externalMetrics.find(
      (m) => m.external.metric.name === "indexer_lag_seconds",
    );
    expect(indexerLagMetric.external.target).toEqual({
      type: "Value",
      value: "10",
    });

    const resourceNames = resourceMetrics.map((m) => m.resource.name);
    expect(resourceNames).toContain("cpu");
    expect(resourceNames).toContain("memory");
  });

  test("k8s/prometheus-adapter-configmap.yaml is valid YAML and contains queue_depth and indexer_lag rules", () => {
    const fileContent = fs.readFileSync(adapterConfigPath, "utf8");
    const doc = yaml.load(fileContent);

    expect(doc.apiVersion).toBe("v1");
    expect(doc.kind).toBe("ConfigMap");
    expect(doc.metadata.name).toBe("prometheus-adapter-config");
    expect(doc.data["config.yaml"]).toBeDefined();

    const adapterConfig = yaml.load(doc.data["config.yaml"]);
    expect(adapterConfig.rules).toBeDefined();
    expect(adapterConfig.externalRules).toBeDefined();

    const externalRuleNames = adapterConfig.externalRules.map((r) => r.name.as);
    expect(externalRuleNames).toContain("queue_depth");
    expect(externalRuleNames).toContain("indexer_lag_seconds");
    for (const rule of adapterConfig.externalRules) {
      expect(rule.metricsQuery).toContain("<<.LabelMatchers>>");
    }
  });

  test("helm/indigopay/values.yaml autoscaling config mirrors k8s/hpa-backend.yaml", () => {
    const fileContent = fs.readFileSync(valuesPath, "utf8");
    const doc = yaml.load(fileContent);

    expect(doc.autoscaling).toBeDefined();
    const metrics = doc.autoscaling.metrics;
    expect(Array.isArray(metrics)).toBe(true);

    const externalMetrics = metrics.filter((m) => m.type === "External");
    const metricNames = externalMetrics.map((m) => m.external.metric.name);
    expect(metricNames).toContain("queue_depth");
    expect(metricNames).toContain("indexer_lag_seconds");

    const indexerLagMetric = externalMetrics.find(
      (m) => m.external.metric.name === "indexer_lag_seconds",
    );
    expect(indexerLagMetric.external.target).toEqual({
      type: "Value",
      value: "10",
    });
    expect(doc.rules.existing).toBe("prometheus-adapter-config");
  });
});
