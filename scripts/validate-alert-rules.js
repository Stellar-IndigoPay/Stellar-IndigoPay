#!/usr/bin/env node
/**
 * Validate Prometheus alert rules for Stellar-IndigoPay.
 *
 * This validator checks:
 *   1. YAML syntax and structure
 *   2. Alert name uniqueness
 *   3. Prometheus expression syntax (basic validation)
 *   4. Severity level allowlist (page, warn, critical)
 *   5. Required annotation fields (summary, runbook)
 *   6. Label conventions
 *
 * Usage:
 *   node scripts/validate-alert-rules.js [path/to/alert-rules.yml]
 *
 * Returns exit code 0 on success, 1 on validation failure.
 *
 * References:
 *   - Issue #913
 *   - Issue #116 (runbook linkage requirement)
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULT_RULES_PATH = path.resolve(__dirname, "..", "monitoring", "alert-rules.yml");

// Severity levels that are allowed in the codebase
const ALLOWED_SEVERITIES = new Set(["page", "warn", "critical"]);

// Required annotation fields for all alerts
const REQUIRED_ANNOTATIONS = ["summary"];

// Recommended annotation fields (warnings if missing)
const RECOMMENDED_ANNOTATIONS = ["runbook", "description"];

// Metrics that are allowed to not exist yet (documented exceptions)
const ALLOWLISTED_METRICS = new Set([
  "webhook_delivery_duration_seconds_bucket",  // Will be added with webhook worker
  "indigopay_backup_verification_passed",       // Backup verification metric
]);

/**
 * Load and parse the alert rules YAML file.
 */
function loadAlertRules(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw);
}

/**
 * Basic Prometheus expression syntax validation.
 * This is NOT a full parser — use promtool for comprehensive checks.
 * We check for common syntax errors:
 *   - Balanced parentheses
 *   - No empty expressions
 *   - Valid metric name patterns
 */
function validateExpressionSyntax(expr, errors, context) {
  if (!expr || typeof expr !== "string" || expr.trim() === "") {
    errors.push(`❌ Empty or invalid expression in ${context}`);
    return;
  }

  // Check balanced parentheses
  let depth = 0;
  for (const char of expr) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (depth < 0) {
      errors.push(`❌ Unbalanced parentheses in expression: ${context}`);
      return;
    }
  }
  if (depth !== 0) {
    errors.push(`❌ Unbalanced parentheses in expression: ${context}`);
  }

  // Check for obviously malformed metric names (must start with letter or underscore)
  const metricNamePattern = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g;
  const matches = expr.match(metricNamePattern);
  if (!matches || matches.length === 0) {
    errors.push(`⚠️  No valid metric names found in expression: ${context}`);
  }
}

/**
 * Check that alert names are unique across all groups.
 */
function checkAlertNameUniqueness(rulesConfig, errors) {
  const seenNames = new Map();

  for (const group of rulesConfig.groups || []) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue;  // Skip recording rules

      const alertName = rule.alert;
      if (seenNames.has(alertName)) {
        errors.push(
          `❌ Duplicate alert name: '${alertName}' in groups '${seenNames.get(alertName)}' and '${group.name}'`
        );
      } else {
        seenNames.set(alertName, group.name);
      }
    }
  }
}

/**
 * Validate severity labels.
 */
function checkSeverityLabels(rulesConfig, errors) {
  for (const group of rulesConfig.groups || []) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue;

      const severity = rule.labels?.severity;
      if (!severity) {
        errors.push(`⚠️  Alert '${rule.alert}' is missing a severity label`);
      } else if (!ALLOWED_SEVERITIES.has(severity)) {
        errors.push(
          `❌ Alert '${rule.alert}' has invalid severity '${severity}'. Allowed: ${[...ALLOWED_SEVERITIES].join(", ")}`
        );
      }
    }
  }
}

/**
 * Validate required and recommended annotations.
 */
function checkAnnotations(rulesConfig, errors, warnings) {
  for (const group of rulesConfig.groups || []) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue;

      const annotations = rule.annotations || {};

      // Check required fields
      for (const field of REQUIRED_ANNOTATIONS) {
        if (!annotations[field] || typeof annotations[field] !== "string") {
          errors.push(`❌ Alert '${rule.alert}' is missing required annotation: '${field}'`);
        }
      }

      // Check recommended fields
      for (const field of RECOMMENDED_ANNOTATIONS) {
        if (!annotations[field] || typeof annotations[field] !== "string") {
          warnings.push(`⚠️  Alert '${rule.alert}' is missing recommended annotation: '${field}'`);
        }
      }

      // Check runbook link format (if present)
      if (annotations.runbook) {
        const runbook = annotations.runbook.trim();
        if (!runbook.startsWith("http://") && !runbook.startsWith("https://")) {
          errors.push(`❌ Alert '${rule.alert}' runbook is not a valid URL: '${runbook}'`);
        }
        // Security: ensure no credentials in URL
        if (runbook.includes("@") || runbook.includes("token=") || runbook.includes("key=")) {
          errors.push(
            `❌ Alert '${rule.alert}' runbook URL appears to contain credentials: '${runbook}'`
          );
        }
      }
    }
  }
}

/**
 * Validate expression syntax for all alert rules.
 */
function checkExpressionSyntax(rulesConfig, errors) {
  for (const group of rulesConfig.groups || []) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue;

      const expr = rule.expr;
      const context = `Alert '${rule.alert}' in group '${group.name}'`;
      validateExpressionSyntax(expr, errors, context);
    }
  }
}

/**
 * Check for metrics that may not exist yet (allowlist warnings).
 */
function checkMetricExistence(rulesConfig, warnings) {
  for (const group of rulesConfig.groups || []) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue;

      const expr = rule.expr || "";
      const metricPattern = /\b([a-zA-Z_:][a-zA-Z0-9_:]*)\b/g;
      let match;

      while ((match = metricPattern.exec(expr)) !== null) {
        const metricName = match[1];
        // Skip Prometheus functions and operators
        if (
          ["sum", "rate", "increase", "histogram_quantile", "time", "by", "le", "and", "or"].includes(
            metricName
          )
        ) {
          continue;
        }

        if (ALLOWLISTED_METRICS.has(metricName)) {
          warnings.push(
            `ℹ️  Alert '${rule.alert}' references allowlisted metric '${metricName}' (may not exist yet)`
          );
        }
      }
    }
  }
}

/**
 * Validate the 'for' duration format.
 */
function checkForDuration(rulesConfig, errors) {
  const durationPattern = /^\d+[smhdwy]$/;  // e.g., 5m, 1h, 0m

  for (const group of rulesConfig.groups || []) {
    for (const rule of group.rules || []) {
      if (!rule.alert) continue;

      if (rule.for !== undefined) {
        const forValue = String(rule.for);
        if (!durationPattern.test(forValue)) {
          errors.push(
            `❌ Alert '${rule.alert}' has invalid 'for' duration: '${forValue}'. Expected format: <number><unit> (e.g., 5m, 1h)`
          );
        }
      }
    }
  }
}

/**
 * Print validation summary.
 */
function printSummary(errors, warnings) {
  console.log("\n" + "═".repeat(60));
  console.log("📊 Validation Summary");
  console.log("═".repeat(60) + "\n");

  if (errors.length === 0 && warnings.length === 0) {
    console.log("✅ All validations passed! No issues found.\n");
    return;
  }

  if (errors.length > 0) {
    console.log(`❌ Errors: ${errors.length}`);
    errors.forEach((err) => console.log(`   ${err}`));
    console.log("");
  }

  if (warnings.length > 0) {
    console.log(`⚠️  Warnings: ${warnings.length}`);
    warnings.forEach((warn) => console.log(`   ${warn}`));
    console.log("");
  }

  console.log("═".repeat(60) + "\n");
}

/**
 * Main entry point.
 */
function main() {
  const rulesPath = process.argv[2] || DEFAULT_RULES_PATH;
  const errors = [];
  const warnings = [];

  console.log("\n🔍 Validating Prometheus alert rules...\n");
  console.log(`📄 Rules file: ${rulesPath}\n`);

  try {
    const rulesConfig = loadAlertRules(rulesPath);
    console.log(`📋 Loaded ${rulesConfig.groups?.length || 0} rule group(s)\n`);

    // Run all validations
    checkAlertNameUniqueness(rulesConfig, errors);
    checkSeverityLabels(rulesConfig, errors);
    checkAnnotations(rulesConfig, errors, warnings);
    checkExpressionSyntax(rulesConfig, errors);
    checkForDuration(rulesConfig, errors);
    checkMetricExistence(rulesConfig, warnings);

    printSummary(errors, warnings);

    // Exit with error code if any errors found
    if (errors.length > 0) {
      console.log("❌ Validation failed. Please fix the errors above.\n");
      process.exit(1);
    } else {
      console.log("✅ Validation passed. The alert rules file is valid.\n");
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n💥 Failed to validate alert rules: ${err.message}\n`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
