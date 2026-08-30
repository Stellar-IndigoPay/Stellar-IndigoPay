#!/usr/bin/env node
/**
 * scripts/validate-alert-rules.js
 *
 * Validates Prometheus alerting rules in monitoring/ to ensure:
 * 1. Every alert rule has a valid `runbook` annotation pointing to a Markdown file in `docs/runbooks/`.
 * 2. The referenced runbook file exists on disk.
 * 3. The runbook contains valid YAML front-matter with all required fields:
 *    - title
 *    - severity
 *    - owners
 *    - symptoms
 *    - steps
 *    - verification
 *    - rollback
 *
 * Usage:
 *   node scripts/validate-alert-rules.js [monitoringDir] [repoRootDir]
 *
 * Exit code 0 on success, 1 on any violation.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const REQUIRED_FRONTMATTER_FIELDS = [
  "title",
  "severity",
  "owners",
  "symptoms",
  "steps",
  "verification",
  "rollback",
];

/**
 * Extract and parse YAML front-matter from a markdown file.
 *
 * @param {string} content
 * @returns {object|null}
 */
function parseFrontMatter(content) {
  if (typeof content !== "string") return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  try {
    return yaml.load(match[1]);
  } catch (e) {
    return null;
  }
}

/**
 * Validate a single runbook markdown file.
 *
 * @param {string} runbookPath
 * @param {string} ruleName
 * @param {string[]} errors
 */
function validateRunbookFile(runbookPath, ruleName, errors) {
  if (!fs.existsSync(runbookPath)) {
    errors.push(`Rule "${ruleName}" references non-existent runbook: ${runbookPath}`);
    return;
  }

  const content = fs.readFileSync(runbookPath, "utf-8");
  const frontMatter = parseFrontMatter(content);

  if (!frontMatter || typeof frontMatter !== "object") {
    errors.push(`Runbook "${runbookPath}" referenced by "${ruleName}" is missing valid YAML front-matter.`);
    return;
  }

  for (const field of REQUIRED_FRONTMATTER_FIELDS) {
    if (!frontMatter[field]) {
      errors.push(
        `Runbook "${runbookPath}" referenced by "${ruleName}" is missing required front-matter field: "${field}".`
      );
    }
  }

  if (frontMatter.owners && !Array.isArray(frontMatter.owners)) {
    errors.push(`Runbook "${runbookPath}" field "owners" must be an array.`);
  }
  if (frontMatter.symptoms && !Array.isArray(frontMatter.symptoms)) {
    errors.push(`Runbook "${runbookPath}" field "symptoms" must be an array.`);
  }
  if (frontMatter.steps && !Array.isArray(frontMatter.steps)) {
    errors.push(`Runbook "${runbookPath}" field "steps" must be an array.`);
  }
  if (frontMatter.verification && !Array.isArray(frontMatter.verification)) {
    errors.push(`Runbook "${runbookPath}" field "verification" must be an array.`);
  }
  if (frontMatter.rollback && !Array.isArray(frontMatter.rollback)) {
    errors.push(`Runbook "${runbookPath}" field "rollback" must be an array.`);
  }
}

/**
 * Validate alert rules in specified files or directory.
 *
 * @param {string} monitoringDir
 * @param {string} repoRootDir
 * @returns {{errors: string[], rulesCount: number, alertFiles: number}}
 */
function validateAlertRules(monitoringDir, repoRootDir) {
  const errors = [];
  let rulesCount = 0;
  let alertFiles = 0;

  if (!fs.existsSync(monitoringDir)) {
    errors.push(`Monitoring directory does not exist: ${monitoringDir}`);
    return { errors, rulesCount, alertFiles };
  }

  const files = fs
    .readdirSync(monitoringDir)
    .filter((f) => f.startsWith("alert-rules") && (f.endsWith(".yml") || f.endsWith(".yaml")));

  for (const file of files) {
    alertFiles++;
    const filePath = path.join(monitoringDir, file);
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(filePath, "utf-8"));
    } catch (err) {
      errors.push(`Failed to parse YAML file ${filePath}: ${err.message}`);
      continue;
    }

    if (!doc || !Array.isArray(doc.groups)) {
      continue;
    }

    for (const group of doc.groups) {
      if (!Array.isArray(group.rules)) continue;

      for (const rule of group.rules) {
        if (!rule.alert) continue; // Skip recording rules
        rulesCount++;

        const alertName = rule.alert;
        const annotations = rule.annotations || {};
        const runbookRelPath = annotations.runbook;

        if (!runbookRelPath || typeof runbookRelPath !== "string" || runbookRelPath.trim() === "") {
          errors.push(
            `Alert rule "${alertName}" in ${file} (group: ${group.name}) is missing required "annotations.runbook"`
          );
          continue;
        }

        // Support relative path (e.g. docs/runbooks/xyz.md) or anchor references
        const cleanPath = runbookRelPath.split("#")[0];
        const fullRunbookPath = path.resolve(repoRootDir, cleanPath);
        validateRunbookFile(fullRunbookPath, alertName, errors);
      }
    }
  }

  return { errors, rulesCount, alertFiles };
}

function main() {
  const repoRootDir = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.resolve(__dirname, "..");
  const monitoringDir = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(repoRootDir, "monitoring");

  console.log(`\n🔍 Validating alert rule runbook linkages in ${monitoringDir}...\n`);

  const { errors, rulesCount, alertFiles } = validateAlertRules(monitoringDir, repoRootDir);

  if (errors.length > 0) {
    console.error(errors.map((e) => `   ❌ ${e}`).join("\n"));
    console.error(
      `\n📊 ${errors.length} violation(s) across ${rulesCount} alert rule(s) in ${alertFiles} file(s).\n`
    );
    process.exit(1);
  }

  console.log(
    `✅ All ${rulesCount} alert rules across ${alertFiles} file(s) have valid, existing runbook linkages with complete front-matter!\n`
  );
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  validateAlertRules,
  parseFrontMatter,
  validateRunbookFile,
  REQUIRED_FRONTMATTER_FIELDS,
};
