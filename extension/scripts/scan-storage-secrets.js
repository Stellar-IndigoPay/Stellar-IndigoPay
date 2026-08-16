#!/usr/bin/env node
/**
 * scan-storage-secrets.js
 *
 * CI guard for issue #656: fails the build if the extension source ever
 * starts persisting private-key / seed-shaped material via chrome.storage,
 * or hardcodes a Stellar secret key.
 *
 * This extension's wallet flow is delegate-only: all signing happens inside
 * the separate Freighter extension via window.freighter.signTransaction().
 * This codebase should only ever see PUBLIC Stellar addresses (G...) and
 * must never read, construct, or persist a SECRET key (S...).
 * See extension/STORAGE_AUDIT.md for the full policy.
 */
const fs = require("fs");
const path = require("path");

const SRC_DIR = path.join(__dirname, "..", "src");

// Stellar secret keys: 'S' + 55 base32 chars (56 total)
const STELLAR_SECRET_KEY = /\bS[A-Z2-7]{55}\b/;

// Storage-key names that should never appear as a chrome.storage.* key
const SECRET_KEY_NAME = /["'`]?\w*(private[_-]?key|secret[_-]?key|seed[_-]?phrase|mnemonic)\w*["'`]?\s*[:,]/i;

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) files.push(full);
  }
  return files;
}

const violations = [];

for (const file of walk(SRC_DIR)) {
  const lines = fs.readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (STELLAR_SECRET_KEY.test(line)) {
      violations.push(`${file}:${i + 1}: hardcoded Stellar secret key pattern found`);
    }
    if (SECRET_KEY_NAME.test(line)) {
      violations.push(`${file}:${i + 1}: possible secret-shaped storage key: "${line.trim()}"`);
    }
  });
}

if (violations.length > 0) {
  console.error("Secret-shaped storage/key violations found:\n");
  violations.forEach((v) => console.error("  " + v));
  console.error("\nSee extension/STORAGE_AUDIT.md for the storage security policy.");
  process.exit(1);
}

console.log("OK: no plaintext secret/private-key patterns found in extension/src.");