#!/usr/bin/env node
"use strict";

/**
 * scripts/trivyignore-gate.js
 *
 * Validator + gate for the structured .trivyignore format (WS5 / #1100).
 *
 * The reviewed .trivyignore format is:
 *
 *   CVE-YYYY-NNNNN # <reason> # <reviewer> # <expiry-YYYY-MM-DD>
 *
 * Trivy's native engine, however, only understands a bare CVE ID per line.
 * This tool bridges the two:
 *
 *   1. Parses every non-comment line of `.trivyignore`.
 *   2. Fails (exit 1) on any malformed entry (missing a required field), any
 *      entry with an invalid date, or any already-EXPIRED exception.
 *   3. Prints each valid entry's bare CVEs (one per line) to stdout so callers
 *      can feed a compatible ignore list to Trivy --ignorefile.
 *
 * Usage:
 *   node scripts/trivyignore-gate.js [path-to-.trivyignore] \
 *       [--today YYYY-MM-DD] > /tmp/trivy-ignore-bare.txt
 *
 * Exit codes: 0 = all entries valid + effective list printed; 1 = invalid /
 * expired entry found (gate FAILS); 2 = file missing / usage error.
 */

const fs = require("fs");
const path = require("path");

const FORMAT =
  /^(CVE|GHSA|GO|RUSTSEC)-[A-Za-z0-9\-]+ #[^#]+# [^#]+# (20[0-9]{2})-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

function parse(lines, today) {
  const issues = [];
  const bare = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    if (!FORMAT.test(line)) {
      issues.push(`  Line ${i + 1}: malformed — expected "CVE-XXXX-##### # reason # reviewer # YYYY-MM-DD".\n    ${line}`);
      continue;
    }
    const cve = line.split(/\s+#\s+/)[0];
    const expiry = line.split(/\s+#\s+/).pop();
    if (new Date(expiry) < new Date(today)) {
      issues.push(`  Line ${i + 1}: EXPIRED exception for ${cve} (expired ${expiry}). Re-review or remove.\n    ${line}`);
      continue;
    }
    bare.push(cve);
  }
  return { issues, bare };
}

function main() {
  const args = process.argv.slice(2);
  let file = ".trivyignore";
  let today = new Date().toISOString().slice(0, 10);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--today") today = args[i + 1];
    else if (i === 0 || (args[i] && !args[i].startsWith("--"))) file = args[i];
  }
  if (!fs.existsSync(file)) {
    console.error(`trivyignore-gate: file not found: ${file}`);
    process.exit(2);
  }
  const lines = fs.readFileSync(file, "utf8").split("\n");
  const { issues, bare } = parse(lines, today);

  for (const issue of issues) console.error(`\x1b[31m[trivyignore-gate] ERROR\x1b[0m\n${issue}`);

  if (issues.length > 0) {
    console.error(`\n[trivyignore-gate] ❌ ${issues.length} invalid/expired exception(s). CI gate FAILED.`);
    process.exit(1);
  }

  // Print effective bare CVEs (one per line) for Trivy --ignorefile.
  bare.forEach((c) => console.log(c));
  console.error(`[trivyignore-gate] ✅ ${bare.length} valid exception(s).`);
}

module.exports = { parse };

if (require.main === module) {
  main();
}