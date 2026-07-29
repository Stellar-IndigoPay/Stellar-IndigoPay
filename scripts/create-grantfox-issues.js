#!/usr/bin/env node
/**
 * Script to parse GRANTFOX_ISSUES.md and create GitHub Issues via `gh issue create`.
 * Usage: node scripts/create-grantfox-issues.js [--dry-run]
 */

const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const DRY_RUN = process.argv.includes("--dry-run");
const ISSUES_FILE = path.join(__dirname, "..", "GRANTFOX_ISSUES.md");

const content = fs.readFileSync(ISSUES_FILE, "utf8");

// Map label names used in GRANTFOX_ISSUES.md to actual repo labels
const LABEL_MAP = {
  "area/contracts": "area: contracts",
  "area/backend": "area: backend",
  "area/frontend": "area: frontend",
  "area/ci": "area: ci",
  "area/mobile": "area: mobile",
  "area/extension": "area: extension",
  "area/docs": "area: docs",
  "area/cross-cutting": "area: cross-cutting",
  "type/bug": "type: bug",
  "type/improvement": "type: enhancement",
  "type/testing": "type: testing",
  "type/security": "area: security",
  "type/a11y": "area: accessibility",
  "priority/high": "priority: high",
  "priority/medium": "priority: medium",
  "priority/low": "priority: low",
  // These labels exist as-is on the repo:
  // "GrantFox OSS", "Official Campaign"
};

function mapLabel(label) {
  return LABEL_MAP[label] || label;
}

// Split on "## Issue #" blocks
const blocks = content.split(/\n(?=## Issue #)/);
const issueBlocks = blocks.slice(1);

console.log(`Found ${issueBlocks.length} issue blocks.`);

let created = 0;
let failed = 0;
const failures = [];

for (const block of issueBlocks) {
  const lines = block.split("\n");

  // Extract title from the first line: "## Issue #XXX — Title"
  const titleLine = lines[0];
  const titleMatch = titleLine.match(/^## Issue #(\d+)\s*[—–-]\s*(.+)$/);
  if (!titleMatch) {
    console.error(`Could not parse title from: ${titleLine}`);
    failed++;
    failures.push(`Parse error: ${titleLine}`);
    continue;
  }
  const issueNumber = titleMatch[1];
  const rawTitle = titleMatch[2].trim();
  const title = `Issue #${issueNumber} — ${rawTitle}`;

  // Extract labels line
  let labelsLine = "";
  for (let i = 1; i < Math.min(lines.length, 5); i++) {
    if (lines[i].includes("**Labels:**")) {
      labelsLine = lines[i];
      break;
    }
  }

  const labelsMatch = labelsLine.match(/\*\*Labels:\*\*\s*(.+)$/);
  const labelStr = labelsMatch ? labelsMatch[1].trim() : "";
  const labels = labelStr
    ? labelStr
        .split(",")
        .map((l) => mapLabel(l.trim().replace(/`/g, "")))
        .filter(Boolean)
    : [];

  // Build body: everything after the title line
  const body = block.slice(lines[0].length).trim();

  const labelArgs = labels.map((l) => `--label "${l.replace(/"/g, '\\"')}"`).join(" ");

  if (DRY_RUN) {
    console.log(`\n[DRY RUN] #${issueNumber}: ${rawTitle}`);
    console.log(`  Labels: ${labels.join(", ")}`);
    created++;
    continue;
  }

  try {
    // Write body to temp file to avoid shell escaping issues
    const tmpBodyFile = `/tmp/gh-issue-body-${issueNumber}.md`;
    fs.writeFileSync(tmpBodyFile, body, "utf8");

    // Write title to temp file to avoid backtick/special-char escaping
    const tmpTitleFile = `/tmp/gh-issue-title-${issueNumber}.txt`;
    fs.writeFileSync(tmpTitleFile, title, "utf8");

    // Use --title-file (not available in all gh versions, fallback to --title)
    // gh version 2.88.0 supports --title from file via $(cat file)
    const cmd = `gh issue create --repo Stellar-IndigoPay/Stellar-IndigoPay --title "$(cat ${tmpTitleFile})" --body-file "${tmpBodyFile}" ${labelArgs}`;

    console.log(`Creating #${issueNumber}: ${rawTitle.slice(0, 80)}...`);
    const result = execSync(cmd, { encoding: "utf8", timeout: 30000, shell: "/bin/bash" });
    console.log(`  ✓ ${result.trim()}`);
    created++;

    // Clean up
    fs.unlinkSync(tmpBodyFile);
    fs.unlinkSync(tmpTitleFile);

    // Rate limit pause every 10 issues
    if (created % 10 === 0) {
      console.log(`  -- Pausing 3s (rate limit)...`);
      execSync("sleep 3");
    }
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : "";
    const shortErr = (stderr + err.message).slice(0, 150);
    console.error(`  ✗ #${issueNumber} FAILED: ${shortErr}`);
    failed++;
    failures.push(`#${issueNumber}: ${shortErr}`);
    // Clean up temp files
    try { fs.unlinkSync(`/tmp/gh-issue-body-${issueNumber}.md`); } catch {}
    try { fs.unlinkSync(`/tmp/gh-issue-title-${issueNumber}.txt`); } catch {}
  }
}

console.log(`\n========================================`);
console.log(`Created: ${created}, Failed: ${failed}`);
if (failures.length > 0) {
  console.log(`\nFailures:`);
  failures.forEach((f) => console.log(`  - ${f}`));
}
