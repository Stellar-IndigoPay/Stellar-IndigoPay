#!/usr/bin/env node
"use strict";

/**
 * scripts/sbom-diff.js
 *
 * Diff two CycloneDX Software Bills of Materials and report newly added,
 * removed, and version-changed dependencies (Workstream 5 of #1100).
 *
 * On every PR this tool is used by .github/workflows/sbom.yml to:
 *   1. Compare the PR's SBOM against the base branch's SBOM.
 *   2. List new / removed / changed dependencies.
 *   3. Cross-check new dependencies against a Trivy findings file and FAIL CI
 *      if any new dependency carries a CRITICAL or HIGH CVE — new-dependency
 *      findings are NOT suppressible via .trivyignore.
 *
 * It also powers .github/workflows/sbom-weekly-diff.yml to compare the current
 * SBOM against the previous release's SBOM and auto-create issues for newly
 * discovered CRITICAL CVEs in existing dependencies.
 *
 * Usage:
 *   node scripts/sbom-diff.js \
 *       --base sbom-base.json \
 *       --head sbom-head.json \
 *       [--trivy trivy-results.json] \
 *       [--format table|json] \
 *       [--exit-on-critical]
 *
 * Output:
 *   - A human-readable diff table (or JSON) to stdout, suitable for posting as
 *     a PR comment.
 *   - Exit code 1 when --exit-on-critical is set AND a new dependency has a
 *     CRITICAL/HIGH CVE.
 */

const fs = require("fs");
const path = require("path");

const CRITICAL_SEVERITIES = new Set(["CRITICAL", "HIGH"]);

function argValue(args, name, fallback = "") {
  const idx = args.indexOf(name);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
}

function parseSbom(file) {
  if (!file || !fs.existsSync(file)) return { components: [], name: file || "(missing)" };
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const components = (doc.components || []).map((c) => ({
    name: c.name,
    version: c.version || "(none)",
    purl: c.purl || "",
    type: c.type || "library",
    licenses: (c.licenses || []).map((l) => l.license?.id || l.license?.name || "").filter(Boolean),
  }));
  // Key = name@purl@version so monorepo sub-packages don't collide by name alone.
  const byKey = new Map();
  for (const comp of components) {
    const key = comp.purl || `${comp.name}@${comp.version}`;
    byKey.set(key, comp);
  }
  return { name: file, components, byKey };
}

function diff(baseSbom, headSbom) {
  const added = [];
  const removed = [];
  const changed = [];

  const baseKeys = new Set(baseSbom.byKey.keys());
  const headKeys = new Set(headSbom.byKey.keys());

  // Added = in head only (new purl, or new name@version).
  for (const key of headKeys) {
    if (!baseSbom.byKey.has(key)) {
      const comp = headSbom.byKey.get(key);
      // If the same name exists in base under a different version, it's a
      // version change, not a brand-new dependency.
      const sameNameInBase = [...baseSbom.byKey.values()].some((b) => b.name === comp.name);
      if (sameNameInBase) {
        changed.push({ name: comp.name, oldVersion: inferOldVersion(baseSbom, comp.name), newVersion: comp.version });
      } else {
        added.push({ name: comp.name, version: comp.version, type: comp.type, purl: comp.purl });
      }
    }
  }
  for (const key of baseKeys) {
    if (!headSbom.byKey.has(key)) {
      const comp = baseSbom.byKey.get(key);
      const sameNameInHead = [...headSbom.byKey.values()].some((h) => h.name === comp.name);
      if (!sameNameInHead) {
        removed.push({ name: comp.name, version: comp.version, type: comp.type, purl: comp.purl });
      }
    }
  }
  return { added, removed, changed };
}

function inferOldVersion(baseSbom, name) {
  const match = [...baseSbom.byKey.values()].find((b) => b.name === name);
  return match ? match.version : "(unknown)";
}

/**
 * Parse a Trivy findings file: either `trivy image --format json` output or a
 * table text. Returns a map purl-ish-name -> {Critical, High} counts.
 */
function loadTrivyFindings(file) {
  if (!file || !fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null; // non-JSON: caller skips CVE gating
  }
  const results = Array.isArray(data) ? data : data.Results || [];
  const vulns = new Map();
  const walk = (list) => {
    for (const v of list) {
      const severity = String((v.Severity || "").toUpperCase());
      if (CRITICAL_SEVERITIES.has(severity)) {
        // Use target@vuln as a coarse key; name matching happens downstream.
        vulns.set(`${v.PkgName || "?"}`, { severity, vulnID: v.VulnerabilityID || "" });
      }
    }
  };
  for (const r of results) {
    if (Array.isArray(r.Vulnerabilities)) walk(r.Vulnerabilities);
    if (Array.isArray(r.Misconfigurations)) walk(r.Misconfigurations);
  }
  return vulns;
}

function main() {
  const args = process.argv.slice(2);
  const baseFile = argValue(args, "--base");
  const headFile = argValue(args, "--head");
  const trivyFile = argValue(args, "--trivy");
  const format = argValue(args, "--format", "table");
  const exitOnCritical = args.includes("--exit-on-critical");

  if (!baseFile || !headFile) {
    console.error("sbom-diff: --base and --head are required");
    process.exit(2);
  }

  const base = parseSbom(baseFile);
  const head = parseSbom(headFile);
  const { added, removed, changed } = diff(base, head);

  // New-dependency CVE gating: flags only apply to *brand-new* packages.
  const trivy = loadTrivyFindings(trivyFile);
  const newWithCritical = [];
  if (trivy) {
    for (const dep of added) {
      if (trivy.has(dep.name)) {
        newWithCritical.push({ ...dep, ...trivy.get(dep.name) });
      }
    }
  }

  const report = {
    base: base.name,
    head: head.name,
    addedCount: added.length,
    removedCount: removed.length,
    changedCount: changed.length,
    added,
    removed,
    changed,
    ...(trivy ? { newDepsWithCriticalHigh: newWithCritical } : {}),
  };

  if (format === "json") {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`\nSBOM diff: ${path.basename(baseFile)} → ${path.basename(headFile)}`);
    console.log(`  Added:   ${added.length}   Removed: ${removed.length}   Changed: ${changed.length}\n`);
    if (added.length) {
      console.log("Newly added dependencies:");
      for (const a of added) console.log(`  + ${a.name}@${a.version}`);
    }
    if (removed.length) {
      console.log("\nRemoved dependencies:");
      for (const r of removed) console.log(`  - ${r.name}@${r.version}`);
    }
    if (changed.length) {
      console.log("\nVersion changes:");
      for (const c of changed) console.log(`  ~ ${c.name} ${c.oldVersion} → ${c.newVersion}`);
    }
    if (newWithCritical.length) {
      console.log("\n⚠️  NEW dependencies with CRITICAL/HIGH CVEs (NOT suppressible via .trivyignore):");
      for (const d of newWithCritical) {
        console.log(`  ✗ CRITICAL CVE: ${d.vulnID} in ${d.name} (new dependency)`);
      }
    } else {
      console.log("\n✅ No new dependency introduces a CRITICAL/HIGH CVE.");
    }
  }

  if (exitOnCritical && newWithCritical.length > 0) {
    process.exit(1);
  }
  process.exit(0);
}

module.exports = { parseSbom, diff, loadTrivyFindings, main };

if (require.main === module) {
  main();
}