#!/usr/bin/env node
"use strict";

/**
 * Static Manifest V3 CSP and extension-page markup check.
 *
 * This intentionally checks only executable inline content and javascript:
 * URLs. Inline styles are allowed because they are outside issue #1140's
 * inline-script/event-handler scope.
 */

const fs = require("fs");
const path = require("path");

const EXTENSION_DIR = path.join(__dirname, "..");
const MANIFEST_FILES = ["manifest.json", "manifest.firefox.json"];
const HTML_FILES = ["popup.html", "settings.html"];
const REQUIRED_CSP = "script-src 'self'; object-src 'none'";
// HTML permits quoted or unquoted attribute values. Restrict the prefix to
// an attribute boundary so data-onclick-like names are not false positives.
const INLINE_EVENT_ATTRIBUTE =
  /(?:^|<|\s)on[a-z][a-z0-9_-]*\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i;
const JAVASCRIPT_URL_ATTRIBUTE =
  /(?:^|<|\s)(?:href|src)\s*=\s*(?:"\s*javascript\s*:|'\s*javascript\s*:|javascript\s*:)/i;

function read(relativePath) {
  return fs.readFileSync(path.join(EXTENSION_DIR, relativePath), "utf8");
}

function fail(issues, message) {
  issues.push(message);
}

function extensionPagesPolicy(manifest) {
  const value = manifest.content_security_policy;
  if (typeof value === "string") return value;
  if (value && typeof value.extension_pages === "string") {
    return value.extension_pages;
  }
  return null;
}

function validatePolicy(policy, file, issues) {
  if (!policy) {
    fail(issues, `${file}: missing content_security_policy.extension_pages`);
    return;
  }

  if (policy !== REQUIRED_CSP) {
    fail(issues, `${file}: extension-pages CSP must be exactly "${REQUIRED_CSP}"`);
  }

  if (/\bunsafe-inline\b/i.test(policy)) {
    fail(issues, `${file}: CSP contains unsafe-inline`);
  }
  if (/\bunsafe-eval\b/i.test(policy)) {
    fail(issues, `${file}: CSP contains unsafe-eval`);
  }

  const scriptSource = policy.match(/(?:^|;)\s*script-src\s+([^;]+)/i);
  if (!scriptSource || scriptSource[1].trim() !== "'self'") {
    fail(issues, `${file}: script-src must permit only 'self'`);
  }

  const objectSource = policy.match(/(?:^|;)\s*object-src\s+([^;]+)/i);
  if (!objectSource || objectSource[1].trim() !== "'none'") {
    fail(issues, `${file}: object-src must be 'none'`);
  }
}

function validateHtml(file, html, issues) {
  const inlineScriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match;
  while ((match = inlineScriptPattern.exec(html)) !== null) {
    if (!/\bsrc\s*=\s*["'][^"']+["']/i.test(match[1])) {
      fail(issues, `${file}: inline <script> body is not allowed`);
    } else if (match[2].trim() !== "") {
      fail(issues, `${file}: script tags with src must not contain inline code`);
    }
  }

  if (INLINE_EVENT_ATTRIBUTE.test(html)) {
    fail(issues, `${file}: inline event-handler attributes are not allowed`);
  }
  if (JAVASCRIPT_URL_ATTRIBUTE.test(html)) {
    fail(issues, `${file}: javascript: URLs are not allowed`);
  }
}

function main() {
  const issues = [];

  for (const file of MANIFEST_FILES) {
    let manifest;
    try {
      manifest = JSON.parse(read(file));
    } catch (err) {
      fail(issues, `${file}: could not parse manifest: ${err.message}`);
      continue;
    }

    if (manifest.manifest_version !== 3) {
      fail(issues, `${file}: manifest_version must be 3`);
    }
    validatePolicy(extensionPagesPolicy(manifest), file, issues);
  }

  for (const file of HTML_FILES) {
    try {
      validateHtml(file, read(file), issues);
    } catch (err) {
      fail(issues, `${file}: could not read HTML: ${err.message}`);
    }
  }

  if (issues.length > 0) {
    console.error("Manifest V3 CSP validation failed:");
    for (const issue of issues) console.error(`  - ${issue}`);
    process.exit(1);
  }

  console.log("Manifest V3 CSP validation passed for Chrome and Firefox manifests.");
}

module.exports = { validateHtml };

if (require.main === module) {
  main();
}
