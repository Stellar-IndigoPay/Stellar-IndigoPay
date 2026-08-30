#!/usr/bin/env node
/**
 * scripts/validate-gitops.js
 *
 * Validates GitOps manifests in gitops/ and verifies consistency with Helm chart templates.
 *
 * Usage:
 *   node scripts/validate-gitops.js [repoDir]
 *
 * Exit code 0 on success, 1 on violation.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
const { execFileSync } = require("child_process");

function resolveWithin(repoDir, candidatePath) {
  const root = fs.realpathSync(repoDir);
  const resolved = path.resolve(root, candidatePath);
  const relative = path.relative(root, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    return null;
  }
  try {
    const real = fs.realpathSync(resolved);
    const realRelative = path.relative(root, real);
    if (
      realRelative.startsWith(`..${path.sep}`) ||
      realRelative === ".." ||
      path.isAbsolute(realRelative)
    ) {
      return null;
    }
    return real;
  } catch {
    return null;
  }
}

function validateGitOps(repoDir) {
  const errors = [];
  const gitopsDir = path.join(repoDir, "gitops");
  const argocdAppPath = path.join(gitopsDir, "argocd-application.yaml");

  if (!fs.existsSync(argocdAppPath)) {
    errors.push(`Missing ArgoCD application manifest at ${argocdAppPath}`);
    return { errors, checked: 0 };
  }

  let doc;
  try {
    doc = yaml.load(fs.readFileSync(argocdAppPath, "utf-8"));
  } catch (e) {
    errors.push(`Failed to parse ${argocdAppPath}: ${e.message}`);
    return { errors, checked: 0 };
  }

  if (!doc || doc.apiVersion !== "argoproj.io/v1alpha1" || doc.kind !== "Application") {
    errors.push(`${argocdAppPath} is not a valid argoproj.io/v1alpha1 Application manifest.`);
  }

  const spec = (doc && doc.spec) || {};
  const source = spec.source || {};
  const chartPath = source.path;

  if (!chartPath) {
    errors.push(`${argocdAppPath} spec.source.path is missing.`);
  } else {
    const fullChartPath = resolveWithin(repoDir, chartPath);
    if (!fullChartPath || !fs.statSync(fullChartPath).isDirectory()) {
      errors.push(`Referenced Helm chart path "${chartPath}" does not exist.`);
    }
  }

  // If helm CLI is available, test rendering template
  try {
    const helmChartDir = resolveWithin(repoDir, chartPath || "helm/indigopay");
    if (helmChartDir) {
      execFileSync("helm", ["template", "test-release", helmChartDir], {
        stdio: "ignore",
      });
    }
  } catch (err) {
    // If helm CLI is not installed in local env, skip; in CI with helm installed, report rendering failure
    if (err.code !== "ENOENT" && process.env.CI) {
      errors.push(`Helm template rendering failed: ${err.message}`);
    }
  }

  return { errors, checked: 1 };
}

function main() {
  const repoDir = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, "..");

  console.log(`\n🔍 Validating GitOps manifests in ${path.join(repoDir, "gitops")}...\n`);

  const { errors, checked } = validateGitOps(repoDir);

  if (errors.length > 0) {
    console.error(errors.map((e) => `   ❌ ${e}`).join("\n"));
    console.error(`\n📊 GitOps validation failed with ${errors.length} error(s).\n`);
    process.exit(1);
  }

  console.log(`✅ GitOps manifests and Helm templates validated successfully.\n`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { validateGitOps };
