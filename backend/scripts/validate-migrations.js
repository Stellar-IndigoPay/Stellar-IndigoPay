#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const MIGRATIONS_DIR = path.join(__dirname, "..", "src", "db", "migrations");

function validateMigrationText(source, fileName) {
  const issues = [];
  const normalized = source.replace(/\s+/g, " ").toLowerCase();
  const hasContractPhase = /phase:\s*"contract"|phase:\s*'contract'|phase:\s*contract/.test(source);

  if (/add column/.test(normalized) && /not null/.test(normalized) && !/default/.test(normalized)) {
    issues.push({
      rule: "not-null-without-default",
      message: "Adding a NOT NULL column without a default breaks expand-contract safety.",
      file: fileName,
    });
  }

  if (/rename column/.test(normalized)) {
    issues.push({
      rule: "rename-column",
      message: "Rename-column migrations must be split into an expand step and a contract step.",
      file: fileName,
    });
  }

  if (/drop column/.test(normalized) && !hasContractPhase) {
    issues.push({
      rule: "drop-without-contract-phase",
      message: "Dropping a column should only happen in a contract-phase migration.",
      file: fileName,
    });
  }

  return issues;
}

function collectMigrationFiles(dir = MIGRATIONS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => path.join(dir, file));
}

function lintMigrations() {
  const files = collectMigrationFiles();
  const issues = [];

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    issues.push(...validateMigrationText(source, path.basename(file)));
  }

  return { files, issues };
}

function main() {
  const result = lintMigrations();
  if (result.issues.length > 0) {
    console.error("Migration policy violations detected:");
    for (const issue of result.issues) {
      console.error(`- [${issue.rule}] ${issue.file}: ${issue.message}`);
    }
    process.exit(1);
  }

  console.log(`Checked ${result.files.length} migration files; no expand-contract violations found.`);
}

if (require.main === module) {
  main();
}

module.exports = { collectMigrationFiles, lintMigrations, validateMigrationText };
