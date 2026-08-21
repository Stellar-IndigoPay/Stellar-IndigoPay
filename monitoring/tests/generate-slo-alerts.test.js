/**
 * Unit tests for the SLO alert generation script.
 *
 * Tests cover:
 *   - Generation script runs successfully
 *   - Generated rules are valid YAML
 *   - Burn-rate calculations are correct
 *   - SLO group is properly injected
 *   - Generation is deterministic (same input → same output)
 *
 * Run with: node monitoring/tests/generate-slo-alerts.test.js
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const yaml = require("js-yaml");

const GENERATOR_SCRIPT = path.resolve(__dirname, "../../scripts/generate-slo-alerts.js");
const SLO_CONFIG_PATH = path.resolve(__dirname, "../slos.yml");
const ALERT_RULES_PATH = path.resolve(__dirname, "../alert-rules.yml");

// ──────────────────────────────────────────────────────────────────────────
// Test: Generation script runs successfully
// ──────────────────────────────────────────────────────────────────────────
function testGenerationRunsSuccessfully() {
  try {
    const output = execSync(`node ${GENERATOR_SCRIPT} --dry-run`, { encoding: "utf-8" });
    assert.match(output, /Generated \d+ burn-rate alert rule/, "Should report number of generated rules");
    assert.match(output, /Dry run complete/, "Should complete in dry-run mode");
    console.log("✅ Test passed: Generation script runs successfully");
  } catch (err) {
    throw new Error(`Generation script failed: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Generated rules are valid YAML
// ──────────────────────────────────────────────────────────────────────────
function testGeneratedRulesAreValidYaml() {
  try {
    const output = execSync(`node ${GENERATOR_SCRIPT} --dry-run`, { encoding: "utf-8" });
    // Extract YAML content between the header and the completion message
    const yamlStart = output.indexOf("groups:");
    const yamlEnd = output.indexOf("✨ Dry run complete");
    assert.ok(yamlStart !== -1, "Dry-run output should contain YAML rules");
    
    const yamlContent = output.substring(yamlStart, yamlEnd).trim();
    const parsed = yaml.load(yamlContent);
    assert.ok(parsed.groups, "Parsed YAML should have groups");
    assert.ok(Array.isArray(parsed.groups[0].rules), "Group should have rules array");
    console.log("✅ Test passed: Generated rules are valid YAML");
  } catch (err) {
    throw new Error(`YAML validation failed: ${err.message}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Burn-rate calculations are correct
// ──────────────────────────────────────────────────────────────────────────
function testBurnRateCalculations() {
  const sloConfig = yaml.load(fs.readFileSync(SLO_CONFIG_PATH, "utf-8"));
  const output = execSync(`node ${GENERATOR_SCRIPT} --dry-run`, { encoding: "utf-8" });
  const yamlStart = output.indexOf("groups:");
  const yamlEnd = output.indexOf("✨ Dry run complete");
  const yamlContent = output.substring(yamlStart, yamlEnd).trim();
  const parsed = yaml.load(yamlContent);

  const rules = parsed.groups[0].rules;
  assert.ok(rules.length > 0, "Should generate at least one rule");

  // Check first SLO's fast burn rule
  const firstSlo = sloConfig.slos[0];
  const fastBurnRate = firstSlo.burn_rates.find((br) => br.window === "1h");
  const expectedThreshold = (firstSlo.error_budget_percent / 100) * fastBurnRate.rate;

  // Convert slo id to PascalCase alert name (e.g., donation-submission-availability -> DonationSubmissionAvailability)
  const expectedAlertPrefix = firstSlo.id
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");
  
  const fastBurnRule = rules.find((r) => r.alert.startsWith(expectedAlertPrefix) && r.alert.includes("1h"));
  assert.ok(fastBurnRule, `Should generate fast burn rule for first SLO (expected name starting with ${expectedAlertPrefix})`);
  assert.match(
    fastBurnRule.expr,
    new RegExp(`> ${expectedThreshold.toFixed(6)}`),
    `Fast burn threshold should be ${expectedThreshold.toFixed(6)}`
  );

  console.log("✅ Test passed: Burn-rate calculations are correct");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: SLO group is properly injected into alert-rules.yml
// ──────────────────────────────────────────────────────────────────────────
function testSloGroupInjection() {
  const alertRules = yaml.load(fs.readFileSync(ALERT_RULES_PATH, "utf-8"));
  const sloGroup = alertRules.groups.find((g) => g.name === "stellar-indigopay-slo-burn-rate");

  assert.ok(sloGroup, "Alert rules should contain SLO burn-rate group");
  assert.ok(Array.isArray(sloGroup.rules), "SLO group should have rules array");
  assert.ok(sloGroup.rules.length > 0, "SLO group should have at least one rule");

  // Check that all SLO rules have required fields
  for (const rule of sloGroup.rules) {
    assert.ok(rule.alert, "Rule should have alert name");
    assert.ok(rule.expr, "Rule should have expression");
    assert.ok(rule.labels?.severity, "Rule should have severity label");
    assert.ok(rule.labels?.slo_id, "Rule should have slo_id label");
    assert.ok(rule.annotations?.summary, "Rule should have summary annotation");
    assert.ok(rule.annotations?.runbook, "Rule should have runbook annotation");
  }

  console.log("✅ Test passed: SLO group properly injected");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Generation is deterministic
// ──────────────────────────────────────────────────────────────────────────
function testDeterministicGeneration() {
  const output1 = execSync(`node ${GENERATOR_SCRIPT} --dry-run`, { encoding: "utf-8" });
  const output2 = execSync(`node ${GENERATOR_SCRIPT} --dry-run`, { encoding: "utf-8" });

  const yamlStart = output1.indexOf("groups:");
  const yamlEnd = output1.indexOf("✨ Dry run complete");
  const yaml1 = output1.substring(yamlStart, yamlEnd).trim();
  
  const yaml2Start = output2.indexOf("groups:");
  const yaml2End = output2.indexOf("✨ Dry run complete");
  const yaml2 = output2.substring(yaml2Start, yaml2End).trim();

  assert.strictEqual(yaml1, yaml2, "Generation should be deterministic (same input → same output)");
  console.log("✅ Test passed: Generation is deterministic");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: All SLOs have burn-rate alerts generated
// ──────────────────────────────────────────────────────────────────────────
function testAllSlosHaveAlerts() {
  const sloConfig = yaml.load(fs.readFileSync(SLO_CONFIG_PATH, "utf-8"));
  const alertRules = yaml.load(fs.readFileSync(ALERT_RULES_PATH, "utf-8"));
  const sloGroup = alertRules.groups.find((g) => g.name === "stellar-indigopay-slo-burn-rate");

  const expectedAlertCount = sloConfig.slos.reduce((sum, slo) => sum + slo.burn_rates.length, 0);
  assert.strictEqual(
    sloGroup.rules.length,
    expectedAlertCount,
    `Should generate ${expectedAlertCount} alerts (${sloConfig.slos.length} SLOs × burn rates)`
  );

  console.log("✅ Test passed: All SLOs have burn-rate alerts");
}

// ──────────────────────────────────────────────────────────────────────────
// Run all tests
// ──────────────────────────────────────────────────────────────────────────
function runTests() {
  console.log("\n🧪 Running SLO alert generation tests...\n");

  try {
    testGenerationRunsSuccessfully();
    testGeneratedRulesAreValidYaml();
    testBurnRateCalculations();
    testSloGroupInjection();
    testDeterministicGeneration();
    testAllSlosHaveAlerts();

    console.log("\n✨ All tests passed!\n");
  } catch (err) {
    console.error(`\n❌ Test failed: ${err.message}\n`);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

runTests();
