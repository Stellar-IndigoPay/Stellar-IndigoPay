"use strict";

/**
 * Tests for scripts/validate-alert-rules.js
 */

const path = require("path");
const fs = require("fs");
const {
  validateAlertRules,
  parseFrontMatter,
} = require("../../../scripts/validate-alert-rules");

describe("validate-alert-rules script", () => {
  const repoRootDir = path.resolve(__dirname, "../../..");
  const monitoringDir = path.join(repoRootDir, "monitoring");

  test("parses valid YAML front-matter correctly", () => {
    const markdown = `---
title: Test Title
severity: page
owners:
  - "@test-owner"
symptoms:
  - Symptom 1
steps:
  - Step 1
verification:
  - Check metric
rollback:
  - Undo deploy
---
# Content`;

    const fm = parseFrontMatter(markdown);
    expect(fm).toBeDefined();
    expect(fm.title).toBe("Test Title");
    expect(fm.severity).toBe("page");
    expect(fm.owners).toEqual(["@test-owner"]);
  });

  test("returns null for markdown without front-matter", () => {
    const markdown = "# Title without front-matter";
    expect(parseFrontMatter(markdown)).toBeNull();
  });

  test("passes validation on repository monitoring directory and runbooks", () => {
    const { errors, rulesCount, alertFiles } = validateAlertRules(monitoringDir, repoRootDir);
    expect(errors).toEqual([]);
    expect(rulesCount).toBeGreaterThan(0);
    expect(alertFiles).toBeGreaterThan(0);
  });
});
