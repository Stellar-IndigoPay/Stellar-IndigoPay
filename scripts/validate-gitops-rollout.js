#!/usr/bin/env node
/**
 * scripts/validate-gitops-rollout.js
 *
 * GrantFox OSS (area/ci): guards against the backend canary Rollout
 * regressing to a state where a failing canary is NOT auto-aborted.
 *
 * Usage:
 *   node scripts/validate-gitops-rollout.js [gitopsDir] [alertRulesFile]
 *
 * Exit code 0 on success, 1 on any violation.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULT_GITOPS_DIR = path.resolve(__dirname, "..", "gitops");
const DEFAULT_ALERT_RULES = path.resolve(__dirname, "..", "monitoring", "alert-rules.yml");
const ROLLOUT_FILE = "argo-rollouts-canary.yaml";

// Loads every YAML document in a `---`-separated multi-doc file.
function loadAllDocuments(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml.loadAll(raw).filter((doc) => doc && typeof doc === "object");
}

/**
 * Validate that the Rollout wires background analysis to run from
 * step 0 and has an explicit abort scale-down delay.
 *
 * @returns {string[]} errors
 */
function validateRollout(rollout, source) {
  const errors = [];
  const canary = rollout.spec && rollout.spec.strategy && rollout.spec.strategy.canary;

  if (!canary) {
    errors.push(`${source}: Rollout is missing spec.strategy.canary`);
    return errors;
  }

  const analysis = canary.analysis;
  if (!analysis || !Array.isArray(analysis.templates) || analysis.templates.length === 0) {
    errors.push(
      `${source}: spec.strategy.canary.analysis (with templates) is required — ` +
        `without it, a failing canary is never auto-aborted`
    );
  } else if (analysis.startingStep !== 0) {
    errors.push(
      `${source}: analysis.startingStep must be 0 (got ${JSON.stringify(analysis.startingStep)}) ` +
        `— a later startingStep leaves early canary steps unmonitored`
    );
  }

  const delay = canary.abortScaleDownDelaySeconds;
  if (typeof delay !== "number" || delay <= 0) {
    errors.push(`${source}: spec.strategy.canary.abortScaleDownDelaySeconds must be a positive number`);
  }

  return { errors, templateNames: (analysis && analysis.templates ? analysis.templates : []).map((t) => t.templateName) };
}

/**
 * Validate that every referenced AnalysisTemplate bounds failures
 * (so analysis actually resolves to Failed and triggers an abort).
 */
function validateAnalysisTemplates(docs, templateNames, source, errors) {
  for (const name of templateNames) {
    const tmpl = docs.find((d) => d.kind === "AnalysisTemplate" && d.metadata && d.metadata.name === name);
    if (!tmpl) {
      errors.push(`${source}: AnalysisTemplate "${name}" referenced but not defined in this file`);
      continue;
    }
    const metrics = (tmpl.spec && tmpl.spec.metrics) || [];
    if (metrics.length === 0) {
      errors.push(`${source}: AnalysisTemplate "${name}" defines no metrics`);
    }
    metrics.forEach((metric, idx) => {
      if (typeof metric.failureLimit !== "number") {
        errors.push(
          `${source}: AnalysisTemplate "${name}" metrics[${idx}] ("${metric.name}") is missing failureLimit`
        );
      }
    });
  }
}

/**
 * Validate that alert-rules.yml still has an alert wired to the
 * Rollout controller's abort event, so an abort is never silent.
 */
function validateAbortAlert(alertRulesFile, errors) {
  if (!fs.existsSync(alertRulesFile)) {
    errors.push(`${alertRulesFile} not found`);
    return;
  }
  const docs = loadAllDocuments(alertRulesFile);
  const groups = docs.flatMap((d) => d.groups || []);
  const rules = groups.flatMap((g) => g.rules || []);
  const hasAbortAlert = rules.some(
    (r) => r.alert && typeof r.expr === "string" && r.expr.includes("RolloutAborted")
  );
  if (!hasAbortAlert) {
    errors.push(`${alertRulesFile}: no alert rule references reason="RolloutAborted"`);
  }
}

function main() {
  const gitopsDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_GITOPS_DIR;
  const alertRulesFile = process.argv[3] ? path.resolve(process.argv[3]) : DEFAULT_ALERT_RULES;
  const rolloutPath = path.join(gitopsDir, ROLLOUT_FILE);

  console.log(`\n🔍 Validating canary auto-abort wiring in ${rolloutPath}...\n`);

  if (!fs.existsSync(rolloutPath)) {
    console.log(`   ❌ ${rolloutPath} not found`);
    process.exit(1);
  }

  let docs;
  try {
    docs = loadAllDocuments(rolloutPath);
  } catch (err) {
    console.log(`   ❌ ${rolloutPath}: YAML parse error: ${err.message}`);
    process.exit(1);
  }

  const rollout = docs.find((d) => d.kind === "Rollout");
  if (!rollout) {
    console.log(`   ❌ ${rolloutPath}: no Rollout document found`);
    process.exit(1);
  }

  const { errors, templateNames } = validateRollout(rollout, ROLLOUT_FILE);
  validateAnalysisTemplates(docs, templateNames, ROLLOUT_FILE, errors);
  validateAbortAlert(alertRulesFile, errors);

  if (errors.length > 0) {
    console.log(errors.map((e) => `   ❌ ${e}`).join("\n"));
    console.log(`\n📊 ${errors.length} violation(s).\n`);
    process.exit(1);
  }

  console.log("✅ Canary auto-abort is wired: background analysis from step 0, bounded failureLimit, abort alert present.\n");
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { validateRollout, validateAnalysisTemplates, validateAbortAlert, loadAllDocuments };
