#!/usr/bin/env node
/**
 * scripts/validate-networkpolicies.js
 *
 * Validates the Kubernetes NetworkPolicies that are actually applied by the
 * default `k8s/kustomization.yaml`. It enforces the default-deny egress
 * posture — no rule may allow traffic to an un-scoped destination (a rule
 * with no `to`/`from` selector) and no `ipBlock` may use a `0.0.0.0/0` (or
 * `::/0`) CIDR.
 *
 * Why scope to kustomization resources? `k8s/opt-in/` holds policies that are
 * deliberately broader (e.g. webhook delivery to arbitrary URLs) and are NOT
 * part of the default deploy. We only gate what ships by default.
 *
 * Usage:
 *   node scripts/validate-networkpolicies.js [k8sDir]
 *
 * Exit code 0 on success, 1 on any violation.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");

const DEFAULT_K8S_DIR = path.resolve(__dirname, "..", "k8s");
const KUSTOMIZATION_FILE = "kustomization.yaml";
const ALLOWED_BROAD_CIDRS = new Set(["0.0.0.0/0", "::/0"]);

/**
 * Load every YAML document in a file (multi-document files are split with
 * `---`, e.g. networkpolicy-allow-postgres-replication.yaml).
 *
 * @param {string} filePath
 * @returns {Array<object>}
 */
function loadAllDocuments(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return yaml
    .loadAll(raw)
    .filter((doc) => doc !== null && doc !== undefined && typeof doc === "object");
}

/**
 * Collect the relative resource paths referenced by a kustomization file.
 *
 * @param {string} kustomizationPath
 * @returns {string[]}
 */
function readKustomizationResources(kustomizationPath) {
  const docs = loadAllDocuments(kustomizationPath);
  const resources = [];
  for (const doc of docs) {
    if (doc && Array.isArray(doc.resources)) {
      resources.push(...doc.resources);
    }
  }
  return resources;
}

/**
 * Validate that an `ipBlock` CIDR does not grant arbitrary-destination access.
 *
 * @param {string} cidr
 * @returns {string|null} Violation message, or null if the CIDR is acceptable.
 */
function checkCidr(cidr) {
  if (typeof cidr !== "string") return null;
  const trimmed = cidr.trim();
  if (ALLOWED_BROAD_CIDRS.has(trimmed)) {
    return `ipBlock cidr "${trimmed}" allows arbitrary destinations`;
  }
  // A `/0` prefix on any family (e.g. 10.0.0.0/0, ::/0) is equivalent to
  // "all hosts". Catch it generically rather than enumerating every form.
  if (/\/0$/.test(trimmed)) {
    return `ipBlock cidr "${trimmed}" is an all-hosts (/0) prefix`;
  }
  return null;
}

/**
 * Validate a single NetworkPolicy document against the default-deny posture.
 *
 * @param {object} policy  Parsed NetworkPolicy document.
 * @param {string} source  File path (for error messages).
 * @param {string[]} errors Accumulator for violation strings.
 */
function validatePolicy(policy, source, errors) {
  const name = (policy.metadata && policy.metadata.name) || "<unnamed>";

  if (policy.kind !== "NetworkPolicy") return;
  if (!policy.apiVersion) {
    errors.push(`${source}: ${name} is missing apiVersion`);
  }
  if (!policy.spec || typeof policy.spec !== "object") {
    errors.push(`${source}: ${name} is missing spec`);
    return;
  }
  if (!policy.spec.podSelector || typeof policy.spec.podSelector !== "object") {
    errors.push(`${source}: ${name} is missing spec.podSelector`);
  }
  if (!Array.isArray(policy.spec.policyTypes) || policy.spec.policyTypes.length === 0) {
    errors.push(`${source}: ${name} is missing spec.policyTypes`);
  }

  // Egress rules: every rule must scope a destination (`to`). A rule with
  // only `ports` (no `to`) matches every destination — the default-deny
  // equivalent of `0.0.0.0/0` that this repo previously shipped.
  if (policy.spec.egress) {
    policy.spec.egress.forEach((rule, idx) => {
      const label = `${source}: ${name} egress[${idx}]`;
      if (!Array.isArray(rule.to) || rule.to.length === 0) {
        errors.push(`${label} has no \`to\` selector — allows egress to ALL destinations`);
        return;
      }
      rule.to.forEach((peer) => {
        if (peer && peer.ipBlock && peer.ipBlock.cidr) {
          const msg = checkCidr(peer.ipBlock.cidr);
          if (msg) errors.push(`${label}: ${msg}`);
        }
      });
    });
  }

  // Ingress rules: mirror the egress check so an allow policy can't silently
  // open the pod to every source.
  if (policy.spec.ingress) {
    policy.spec.ingress.forEach((rule, idx) => {
      const label = `${source}: ${name} ingress[${idx}]`;
      if (!Array.isArray(rule.from) || rule.from.length === 0) {
        errors.push(`${label} has no \`from\` selector — allows ingress from ALL sources`);
      }
    });
  }
}

/**
 * Run the full validation over a k8s directory.
 *
 * @param {string} k8sDir
 * @returns {{errors: string[], policies: number}} Validation result.
 */
function validateNetworkPolicies(k8sDir) {
  const errors = [];
  const kustomizationPath = path.join(k8sDir, KUSTOMIZATION_FILE);

  if (!fs.existsSync(kustomizationPath)) {
    return {
      errors: [`${kustomizationPath} not found — cannot determine the applied resource set`],
      policies: 0,
    };
  }

  const resources = readKustomizationResources(kustomizationPath);
  if (resources.length === 0) {
    return {
      errors: [`${kustomizationPath} declares no resources`],
      policies: 0,
    };
  }

  let policyCount = 0;
  for (const relPath of resources) {
    const filePath = path.join(k8sDir, relPath);
    if (!fs.existsSync(filePath)) {
      errors.push(`${relPath} (referenced by ${KUSTOMIZATION_FILE}) does not exist`);
      continue;
    }

    let docs;
    try {
      docs = loadAllDocuments(filePath);
    } catch (err) {
      errors.push(`${relPath}: YAML parse error: ${err.message}`);
      continue;
    }

    for (const doc of docs) {
      if (doc.kind === "NetworkPolicy") {
        policyCount++;
        validatePolicy(doc, relPath, errors);
      }
    }
  }

  return { errors, policies: policyCount };
}

/**
 * CLI entry point.
 */
function main() {
  const k8sDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_K8S_DIR;

  console.log(`\n🔍 Validating NetworkPolicies in ${k8sDir}...\n`);

  const { errors, policies } = validateNetworkPolicies(k8sDir);

  if (errors.length > 0) {
    console.log(errors.map((e) => `   ❌ ${e}`).join("\n"));
    console.log(`\n📊 ${errors.length} violation(s) across ${policies} NetworkPolicy resource(s).\n`);
    process.exit(1);
  }

  console.log(`✅ All ${policies} applied NetworkPolicies satisfy the default-deny posture (no un-scoped egress, no 0.0.0.0/0).\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { validateNetworkPolicies, checkCidr, loadAllDocuments, readKustomizationResources };
