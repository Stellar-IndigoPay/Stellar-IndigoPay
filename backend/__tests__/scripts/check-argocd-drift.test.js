"use strict";

/**
 * Tests for scripts/check-argocd-drift.js
 */

const path = require("path");
const fs = require("fs");
const { evaluateArgoCDStatus } = require("../../../scripts/check-argocd-drift");

describe("check-argocd-drift script", () => {
  const syncedFixturePath = path.resolve(__dirname, "../fixtures/argocd-synced.json");
  const driftedFixturePath = path.resolve(__dirname, "../fixtures/argocd-drifted.json");

  test("evaluates Synced and Healthy status cleanly", () => {
    const doc = JSON.parse(fs.readFileSync(syncedFixturePath, "utf-8"));
    const result = evaluateArgoCDStatus(doc);

    expect(result.synced).toBe(true);
    expect(result.healthy).toBe(true);
    expect(result.syncStatus).toBe("Synced");
    expect(result.healthStatus).toBe("Healthy");
    expect(result.driftedResources).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("evaluates OutOfSync and Degraded status correctly", () => {
    const doc = JSON.parse(fs.readFileSync(driftedFixturePath, "utf-8"));
    const result = evaluateArgoCDStatus(doc);

    expect(result.synced).toBe(false);
    expect(result.healthy).toBe(false);
    expect(result.syncStatus).toBe("OutOfSync");
    expect(result.healthStatus).toBe("Degraded");
    expect(result.driftedResources).toHaveLength(2);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("handles null or malformed document safely", () => {
    const result = evaluateArgoCDStatus(null);
    expect(result.synced).toBe(false);
    expect(result.healthy).toBe(false);
    expect(result.errors).toContain("Invalid or empty ArgoCD application payload.");
  });
});
