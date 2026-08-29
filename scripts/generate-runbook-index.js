#!/usr/bin/env node
/**
 * scripts/generate-runbook-index.js
 *
 * Scans monitoring/alert-rules*.yml files, parses all rules and linked runbooks,
 * and generates/updates `docs/runbooks/README.md` with an up-to-date index.
 *
 * Usage:
 *   node scripts/generate-runbook-index.js
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { parseFrontMatter } = require("./validate-alert-rules");

const REPO_ROOT = path.resolve(__dirname, "..");
const MONITORING_DIR = path.join(REPO_ROOT, "monitoring");
const RUNBOOKS_DIR = path.join(REPO_ROOT, "docs", "runbooks");
const INDEX_FILE = path.join(RUNBOOKS_DIR, "README.md");

function generateIndex() {
  const alertFiles = fs
    .readdirSync(MONITORING_DIR)
    .filter((f) => f.startsWith("alert-rules") && (f.endsWith(".yml") || f.endsWith(".yaml")));

  const entries = [];

  for (const file of alertFiles) {
    const filePath = path.join(MONITORING_DIR, file);
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(filePath, "utf-8"));
    } catch (e) {
      continue;
    }
    if (!doc || !Array.isArray(doc.groups)) continue;

    for (const group of doc.groups) {
      if (!Array.isArray(group.rules)) continue;
      for (const rule of group.rules) {
        if (!rule.alert) continue;

        const alertName = rule.alert;
        const groupName = group.name;
        const severity = (rule.labels && rule.labels.severity) || "warn";
        const summary = (rule.annotations && rule.annotations.summary) || "";
        const runbookPath = (rule.annotations && rule.annotations.runbook) || "";

        let runbookTitle = alertName;
        let relativeRunbook = runbookPath;

        if (runbookPath) {
          const cleanPath = runbookPath.split("#")[0];
          const fullPath = path.resolve(REPO_ROOT, cleanPath);
          if (fs.existsSync(fullPath)) {
            const fm = parseFrontMatter(fs.readFileSync(fullPath, "utf-8"));
            if (fm && fm.title) {
              runbookTitle = fm.title;
            }
          }
        }

        entries.push({
          alertName,
          groupName,
          severity,
          summary,
          runbookPath,
          runbookTitle,
          file,
        });
      }
    }
  }

  // Sort by severity (critical/page first) then alertName
  const severityWeight = { critical: 1, page: 2, warn: 3 };
  entries.sort((a, b) => {
    const wA = severityWeight[a.severity] || 4;
    const wB = severityWeight[b.severity] || 4;
    if (wA !== wB) return wA - wB;
    return a.alertName.localeCompare(b.alertName);
  });

  let md = `# Incident Response Runbook Index

This directory contains versioned, actionable runbooks for all Prometheus alert rules in Stellar-IndigoPay.

> [!IMPORTANT]
> **Runbook-as-Code Policy**: Every alert rule in \`monitoring/\` MUST have a \`runbook\` annotation pointing to an existing document in \`docs/runbooks/\`. CI automatically validates this linkage on every PR.

## Alert Rules & Runbook Matrix

| Alert Name | Severity | Group | Summary | Runbook Document |
| :--- | :--- | :--- | :--- | :--- |
`;

  for (const entry of entries) {
    const runbookLink = entry.runbookPath
      ? `[${entry.runbookTitle}](../../${entry.runbookPath})`
      : "*Missing*";
    md += `| \`${entry.alertName}\` | \`${entry.severity}\` | \`${entry.groupName}\` | ${entry.summary.replace(/\|/g, "\\|")} | ${runbookLink} |\n`;
  }

  md += `\n\n*Generated automatically by \`scripts/generate-runbook-index.js\`.*\n`;

  fs.mkdirSync(RUNBOOKS_DIR, { recursive: true });
  fs.writeFileSync(INDEX_FILE, md, "utf-8");
  console.log(`✅ Updated runbook index at ${INDEX_FILE}`);
}

if (require.main === module) {
  generateIndex();
}

module.exports = { generateIndex };
