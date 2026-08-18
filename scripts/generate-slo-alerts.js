#!/usr/bin/env node
/**
 * Generate burn-rate alert rules from the SLO configuration.
 *
 * This script reads monitoring/slos.yml and produces Prometheus alert rules
 * following the Google SRE multi-window burn-rate pattern. The generated
 * rules are inserted into monitoring/alert-rules.yml under a dedicated group.
 *
 * Usage:
 *   node scripts/generate-slo-alerts.js [--dry-run]
 *
 * Options:
 *   --dry-run  Print generated rules to stdout without modifying alert-rules.yml
 *
 * References:
 *   - Google SRE Workbook Ch. 5: https://sre.google/workbook/alerting-on-slos/
 *   - Issue #913
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const SLO_CONFIG_PATH = path.resolve(__dirname, "..", "monitoring", "slos.yml");
const ALERT_RULES_PATH = path.resolve(__dirname, "..", "monitoring", "alert-rules.yml");
const SLO_GROUP_NAME = "stellar-indigopay-slo-burn-rate";

/**
 * Load and parse the SLO configuration.
 */
function loadSloConfig(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw);
}

/**
 * Load and parse the alert rules file.
 */
function loadAlertRules(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.load(raw);
}

/**
 * Generate a Prometheus alert rule from an SLO and burn rate spec.
 *
 * For availability SLOs:
 *   error_rate = 1 - (success / total)
 *   burn_condition = error_rate > (error_budget * burn_rate_multiplier)
 *
 * For latency SLOs:
 *   burn_condition = latency > target_latency
 *   (simplified; full budget tracking requires histogram analysis)
 */
function generateBurnRateAlert(slo, burnRate) {
  const alertName = `${slo.id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")}BurnRate${burnRate.window.replace(/[^a-zA-Z0-9]/g, "")}`;

  let expr;
  if (slo.metric.success_expr && slo.metric.total_expr) {
    // Availability SLO
    const errorBudget = slo.error_budget_percent / 100;
    const threshold = errorBudget * burnRate.rate;
    const window = burnRate.window;

    // Substitute {{.window}} placeholder in metric expressions
    const successExpr = slo.metric.success_expr.replace(/\{\{\.window\}\}/g, window);
    const totalExpr = slo.metric.total_expr.replace(/\{\{\.window\}\}/g, window);

    expr = `(
  1 - (
    (${successExpr})
      /
    (${totalExpr})
  )
) > ${threshold.toFixed(6)}`;
  } else if (slo.metric.latency_expr) {
    // Latency SLO
    const targetLatency = slo.target_latency_seconds;
    const window = burnRate.window;
    const latencyExpr = slo.metric.latency_expr.replace(/\{\{\.window\}\}/g, window);

    expr = `(${latencyExpr}) > ${targetLatency}`;
  } else {
    throw new Error(`SLO '${slo.id}' has invalid metric configuration`);
  }

  return {
    alert: alertName,
    expr: expr.trim(),
    for: burnRate.for,
    labels: {
      severity: burnRate.severity,
      slo_id: slo.id,
      slo_window: burnRate.window,
    },
    annotations: {
      summary: burnRate.annotations.summary,
      description: burnRate.annotations.description.trim(),
      runbook: burnRate.annotations.runbook,
      slo_name: slo.name,
      slo_objective: `${slo.objective}%`,
    },
  };
}

/**
 * Generate all burn-rate alerts for all SLOs.
 */
function generateAllAlerts(sloConfig) {
  const alerts = [];
  for (const slo of sloConfig.slos) {
    for (const burnRate of slo.burn_rates) {
      alerts.push(generateBurnRateAlert(slo, burnRate));
    }
  }
  return alerts;
}

/**
 * Insert or update the SLO burn-rate group in the alert rules file.
 */
function injectSloAlerts(alertRulesConfig, sloAlerts) {
  const groups = alertRulesConfig.groups || [];
  let sloGroupIndex = groups.findIndex((g) => g.name === SLO_GROUP_NAME);

  const sloGroup = {
    name: SLO_GROUP_NAME,
    interval: "30s",
    rules: sloAlerts,
  };

  if (sloGroupIndex === -1) {
    // Append new group
    groups.push(sloGroup);
  } else {
    // Replace existing group
    groups[sloGroupIndex] = sloGroup;
  }

  alertRulesConfig.groups = groups;
  return alertRulesConfig;
}

/**
 * Main entry point.
 */
function main() {
  const isDryRun = process.argv.includes("--dry-run");

  console.log("🔧 Generating SLO burn-rate alerts...\n");

  try {
    const sloConfig = loadSloConfig(SLO_CONFIG_PATH);
    console.log(`📄 Loaded SLO config: version ${sloConfig.version}, ${sloConfig.slos.length} SLO(s)\n`);

    const alerts = generateAllAlerts(sloConfig);
    console.log(`✅ Generated ${alerts.length} burn-rate alert rule(s)\n`);

    if (isDryRun) {
      console.log("🌵 Dry run mode — printing generated rules:\n");
      const dryRunGroup = {
        groups: [
          {
            name: SLO_GROUP_NAME,
            interval: "30s",
            rules: alerts,
          },
        ],
      };
      console.log(yaml.dump(dryRunGroup, { lineWidth: -1, noRefs: true }));
      console.log("\n✨ Dry run complete. No files were modified.\n");
    } else {
      const alertRulesConfig = loadAlertRules(ALERT_RULES_PATH);
      const updatedConfig = injectSloAlerts(alertRulesConfig, alerts);

      fs.writeFileSync(
        ALERT_RULES_PATH,
        yaml.dump(updatedConfig, { lineWidth: -1, noRefs: true }),
        "utf-8"
      );

      console.log(`💾 Updated ${ALERT_RULES_PATH}\n`);
      console.log("✨ SLO burn-rate alerts have been generated and injected.\n");
    }
  } catch (err) {
    console.error(`\n💥 Failed to generate SLO alerts: ${err.message}\n`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
