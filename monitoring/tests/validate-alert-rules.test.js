/**
 * Unit tests for the alert rules validator.
 *
 * Tests cover:
 *   - Valid rules pass without errors
 *   - Duplicate alert names are detected
 *   - Invalid severity levels are rejected
 *   - Missing required annotations are flagged
 *   - Malformed expressions are caught
 *   - Invalid 'for' durations are rejected
 *
 * Run with: npm test (or node --test if using Node.js 20+)
 */
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const VALIDATOR_SCRIPT = path.resolve(__dirname, "../../scripts/validate-alert-rules.js");
const TEST_FIXTURES_DIR = path.resolve(__dirname, "fixtures");

// Ensure fixtures directory exists
if (!fs.existsSync(TEST_FIXTURES_DIR)) {
  fs.mkdirSync(TEST_FIXTURES_DIR, { recursive: true });
}

/**
 * Helper: Run the validator on a temporary rules file.
 */
function validateRules(rulesContent) {
  const tempFile = path.join(TEST_FIXTURES_DIR, `temp-rules-${Date.now()}.yml`);
  fs.writeFileSync(tempFile, rulesContent, "utf-8");

  try {
    execSync(`node ${VALIDATOR_SCRIPT} ${tempFile}`, { encoding: "utf-8", stdio: "pipe" });
    fs.unlinkSync(tempFile);
    return { success: true, output: "" };
  } catch (err) {
    fs.unlinkSync(tempFile);
    return { success: false, output: err.stdout || err.message };
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Valid rules pass
// ──────────────────────────────────────────────────────────────────────────
function testValidRulesPass() {
  const validRules = `
groups:
  - name: test-group
    interval: 30s
    rules:
      - alert: TestAlert
        expr: up == 0
        for: 5m
        labels:
          severity: warn
        annotations:
          summary: "Test alert summary"
          description: "Test alert description"
          runbook: "https://example.com/runbook"
`;

  const result = validateRules(validRules);
  assert.strictEqual(result.success, true, "Valid rules should pass validation");
  console.log("✅ Test passed: Valid rules pass");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Duplicate alert names are detected
// ──────────────────────────────────────────────────────────────────────────
function testDuplicateAlertNames() {
  const duplicateRules = `
groups:
  - name: group1
    rules:
      - alert: DuplicateAlert
        expr: up == 0
        labels:
          severity: warn
        annotations:
          summary: "First alert"
  - name: group2
    rules:
      - alert: DuplicateAlert
        expr: up == 1
        labels:
          severity: page
        annotations:
          summary: "Second alert"
`;

  const result = validateRules(duplicateRules);
  assert.strictEqual(result.success, false, "Duplicate alert names should fail validation");
  assert.match(result.output, /Duplicate alert name/, "Error message should mention duplicate names");
  console.log("✅ Test passed: Duplicate alert names detected");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Invalid severity levels are rejected
// ──────────────────────────────────────────────────────────────────────────
function testInvalidSeverity() {
  const invalidSeverityRules = `
groups:
  - name: test-group
    rules:
      - alert: BadSeverity
        expr: up == 0
        labels:
          severity: invalid_severity
        annotations:
          summary: "Alert with bad severity"
`;

  const result = validateRules(invalidSeverityRules);
  assert.strictEqual(result.success, false, "Invalid severity should fail validation");
  assert.match(result.output, /invalid severity/, "Error message should mention invalid severity");
  console.log("✅ Test passed: Invalid severity rejected");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Missing required annotations are flagged
// ──────────────────────────────────────────────────────────────────────────
function testMissingAnnotations() {
  const missingAnnotationsRules = `
groups:
  - name: test-group
    rules:
      - alert: NoSummary
        expr: up == 0
        labels:
          severity: warn
        annotations:
          description: "Has description but no summary"
`;

  const result = validateRules(missingAnnotationsRules);
  assert.strictEqual(result.success, false, "Missing required annotation should fail validation");
  assert.match(result.output, /missing required annotation/, "Error message should mention missing annotation");
  console.log("✅ Test passed: Missing annotations flagged");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Malformed expressions are caught
// ──────────────────────────────────────────────────────────────────────────
function testMalformedExpression() {
  const malformedExprRules = `
groups:
  - name: test-group
    rules:
      - alert: BadExpression
        expr: "sum(rate(http_requests_total[5m]))))"
        labels:
          severity: warn
        annotations:
          summary: "Alert with unbalanced parentheses"
`;

  const result = validateRules(malformedExprRules);
  assert.strictEqual(result.success, false, "Malformed expression should fail validation");
  assert.match(result.output, /Unbalanced parentheses/, "Error message should mention unbalanced parentheses");
  console.log("✅ Test passed: Malformed expression caught");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Invalid 'for' durations are rejected
// ──────────────────────────────────────────────────────────────────────────
function testInvalidForDuration() {
  const invalidForRules = `
groups:
  - name: test-group
    rules:
      - alert: BadForDuration
        expr: up == 0
        for: "not_a_duration"
        labels:
          severity: warn
        annotations:
          summary: "Alert with invalid for duration"
`;

  const result = validateRules(invalidForRules);
  assert.strictEqual(result.success, false, "Invalid 'for' duration should fail validation");
  assert.match(result.output, /invalid 'for' duration/, "Error message should mention invalid for duration");
  console.log("✅ Test passed: Invalid for duration rejected");
}

// ──────────────────────────────────────────────────────────────────────────
// Test: Empty expression is caught
// ──────────────────────────────────────────────────────────────────────────
function testEmptyExpression() {
  const emptyExprRules = `
groups:
  - name: test-group
    rules:
      - alert: EmptyExpr
        expr: ""
        labels:
          severity: warn
        annotations:
          summary: "Alert with empty expression"
`;

  const result = validateRules(emptyExprRules);
  assert.strictEqual(result.success, false, "Empty expression should fail validation");
  assert.match(result.output, /Empty or invalid expression/, "Error message should mention empty expression");
  console.log("✅ Test passed: Empty expression caught");
}

// ──────────────────────────────────────────────────────────────────────────
// Run all tests
// ──────────────────────────────────────────────────────────────────────────
function runTests() {
  console.log("\n🧪 Running alert rules validator tests...\n");

  try {
    testValidRulesPass();
    testDuplicateAlertNames();
    testInvalidSeverity();
    testMissingAnnotations();
    testMalformedExpression();
    testInvalidForDuration();
    testEmptyExpression();

    console.log("\n✨ All tests passed!\n");
  } catch (err) {
    console.error(`\n❌ Test failed: ${err.message}\n`);
    process.exit(1);
  }
}

runTests();
