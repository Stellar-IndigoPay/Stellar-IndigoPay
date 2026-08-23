#!/usr/bin/env node
"use strict";

/**
 * scripts/validate-permissions.js
 *
 * Least-privilege gate for the extension manifests. Verifies that:
 *   1. Every entry in `permissions` is actually consumed by the source, and
 *   2. Every `host_permissions` pattern is scoped to a host the source
 *      actually calls (over-broad patterns such as `<all_urls>` are rejected).
 *
 * Exits 0 when clean, 1 when any manifest declares an unused permission or an
 * unjustified host grant. Run via `npm run check:permissions`.
 */

const fs = require("fs");
const path = require("path");

const EXTENSION_DIR = path.join(__dirname, "..");
const MANIFEST_FILES = ["manifest.json", "manifest.firefox.json"];

/**
 * Permission name → regular expressions. Any match proves the permission is
 * used. `activeTab` has no greppable API surface, so its presence is always
 * treated as unused (the content script runs on <all_urls> instead).
 */
const PERMISSION_USAGE = {
  storage: [/chrome\.storage/, /browser\.storage/],
  contextMenus: [/chrome\.contextMenus/, /browser\.contextMenus/],
  scripting: [/chrome\.scripting/, /browser\.scripting/],
  activeTab: [],
  tabs: [/chrome\.tabs\.(query|create|update|duplicate|move|reload|remove|get)/],
};

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".html", ".css"]);

/** Collect the text of every source file (src/** plus the popup/settings HTML). */
function collectSourceText() {
  const parts = [];

  const readDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        readDir(full);
        continue;
      }
      if (!SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        continue;
      }
      try {
        parts.push(fs.readFileSync(full, "utf8"));
      } catch {
        // Binary or unreadable — skip.
      }
    }
  };

  readDir(path.join(EXTENSION_DIR, "src"));
  for (const html of ["popup.html", "settings.html"]) {
    const full = path.join(EXTENSION_DIR, html);
    if (fs.existsSync(full)) {
      parts.push(fs.readFileSync(full, "utf8"));
    }
  }
  return parts.join("\n");
}

/** Extract a searchable domain from a host-permission pattern. */
function hostDomain(pattern) {
  if (typeof pattern !== "string") return null;
  if (pattern === "<all_urls>" || pattern === "*://*/*") return null;
  const match = pattern.match(/^[a-z][a-z0-9+.-]*:\/\/([^/]+)/i);
  if (!match) return null;
  return match[1].replace(/:\d+$/, "").replace(/^\*\./, "");
}

function main() {
  const source = collectSourceText();
  const sourceLower = source.toLowerCase();
  const issues = [];

  for (const file of MANIFEST_FILES) {
    const fullPath = path.join(EXTENSION_DIR, file);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    } catch (err) {
      issues.push(`${file}: could not parse manifest: ${err.message}`);
      continue;
    }

    for (const permission of manifest.permissions || []) {
      const patterns = PERMISSION_USAGE[permission];
      const used =
        patterns &&
        patterns.length > 0 &&
        patterns.some((re) => re.test(source));
      if (!used) {
        issues.push(
          `${file}: permission "${permission}" is not referenced by any source file`,
        );
      }
    }

    for (const host of manifest.host_permissions || []) {
      const domain = hostDomain(host);
      if (!domain) {
        issues.push(
          `${file}: host_permissions entry "${host}" is over-broad (must be scoped to a specific host)`,
        );
        continue;
      }
      if (!sourceLower.includes(domain.toLowerCase())) {
        issues.push(
          `${file}: host_permissions entry "${host}" is not referenced by any source file`,
        );
      }
    }
  }

  if (issues.length > 0) {
    console.error("Extension permission audit failed:");
    for (const issue of issues) {
      console.error(`  - ${issue}`);
    }
    process.exit(1);
  }

  console.log("Extension permission audit passed: all permissions are used and scoped.");
}

main();
