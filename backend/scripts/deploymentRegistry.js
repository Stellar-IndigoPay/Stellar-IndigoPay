#!/usr/bin/env node
"use strict";

/**
 * backend/scripts/deploymentRegistry.js
 *
 * Read/write/validate logic for `contracts/deployments.json` — the
 * persistent, versioned registry of Soroban contract deployments (issue
 * #921). Kept as testable Node.js rather than inline bash so the
 * atomicity, schema-validation, and hash-comparison logic has real unit
 * test coverage; `scripts/deploy-contract.sh` shells out to this file's
 * CLI for every registry read/write.
 *
 * Registry shape:
 *   { "deployments": [ <entry>, ... ] }   — append-only, newest last.
 *
 * Entry shape (all fields required and non-empty):
 *   {
 *     id, network, contractId, gitSha, wasmSha256, deployedAt,
 *     identity, deployerAddress, env, verified, verificationDetail
 *   }
 *
 * The registry is append-only (never overwritten in place) so it reads
 * as a straightforward audit trail — including for a contract id that
 * gets deployed more than once (e.g. deterministic-salt re-deploys).
 * `getLatestDeployment` picks the most recent entry for a given
 * network+contractId when callers need "the current one".
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const REQUIRED_FIELDS = [
  "id",
  "network",
  "contractId",
  "gitSha",
  "wasmSha256",
  "deployedAt",
  "identity",
  "deployerAddress",
  "env",
];

const WASM_SHA256_RE = /^[0-9a-f]{64}$/;
const GIT_SHA_RE = /^[0-9a-f]{7,40}$/;

/**
 * @param {string} wasmPath
 * @returns {string} lowercase hex sha256 of the file contents.
 */
function computeWasmSha256(wasmPath) {
  const buf = fs.readFileSync(wasmPath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Validate every entry in a registry object. Throws a single Error
 * listing every violation found (not just the first) so a CI run
 * reports everything wrong in one pass.
 *
 * @param {{ deployments: object[] }} registry
 * @throws {Error}
 */
function validateRegistrySchema(registry) {
  const issues = [];

  if (!registry || typeof registry !== "object" || !Array.isArray(registry.deployments)) {
    throw new Error('Registry must be an object with a "deployments" array');
  }

  registry.deployments.forEach((entry, index) => {
    for (const field of REQUIRED_FIELDS) {
      const value = entry[field];
      if (value === undefined || value === null || value === "") {
        issues.push(`deployments[${index}]: missing or empty required field "${field}"`);
      }
    }
    if (typeof entry.wasmSha256 === "string" && !WASM_SHA256_RE.test(entry.wasmSha256)) {
      issues.push(`deployments[${index}]: wasmSha256 is not a 64-char hex sha256 (got "${entry.wasmSha256}")`);
    }
    if (typeof entry.gitSha === "string" && !GIT_SHA_RE.test(entry.gitSha)) {
      issues.push(`deployments[${index}]: gitSha is not a valid hex git SHA (got "${entry.gitSha}")`);
    }
    if (entry.deployedAt && Number.isNaN(Date.parse(entry.deployedAt))) {
      issues.push(`deployments[${index}]: deployedAt is not a valid ISO timestamp (got "${entry.deployedAt}")`);
    }
    if (typeof entry.verified !== "boolean") {
      issues.push(`deployments[${index}]: "verified" must be a boolean`);
    }
  });

  if (issues.length > 0) {
    throw new Error(`Deployment registry schema violations:\n  ${issues.join("\n  ")}`);
  }
}

/**
 * Read and validate the registry at `registryPath`. A missing file is not
 * an error — it returns the empty registry shape, so a fresh repo (or a
 * fresh network) starts clean.
 *
 * @param {string} registryPath
 * @returns {{ deployments: object[] }}
 */
function loadRegistry(registryPath) {
  if (!fs.existsSync(registryPath)) {
    return { deployments: [] };
  }
  const raw = fs.readFileSync(registryPath, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Deployment registry at ${registryPath} is not valid JSON: ${err.message}`);
  }
  validateRegistrySchema(parsed);
  return parsed;
}

/**
 * Atomically write `registry` to `registryPath`: write to a sibling temp
 * file, then rename over the destination. A `rename` within the same
 * directory is atomic on POSIX filesystems, so a reader (or a crashed
 * writer) never observes a half-written file.
 *
 * @param {string} registryPath
 * @param {{ deployments: object[] }} registry
 */
function writeRegistryAtomic(registryPath, registry) {
  validateRegistrySchema(registry);
  const dir = path.dirname(registryPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(
    dir,
    `.${path.basename(registryPath)}.${process.pid}.${Date.now()}.tmp`,
  );
  fs.writeFileSync(tmpPath, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  fs.renameSync(tmpPath, registryPath);
}

/**
 * Append a new deployment entry and write the registry atomically.
 *
 * @param {string} registryPath
 * @param {object} entryInput — every REQUIRED_FIELDS value except `id`,
 *   plus optional `verified` (default true) and `verificationDetail`.
 * @returns {object} the stored entry (with its generated `id`).
 */
function recordDeployment(registryPath, entryInput) {
  const registry = loadRegistry(registryPath);
  const entry = {
    id: crypto.randomUUID(),
    verified: true,
    verificationDetail: null,
    ...entryInput,
  };
  validateRegistrySchema({ deployments: [entry] });
  registry.deployments.push(entry);
  writeRegistryAtomic(registryPath, registry);
  return entry;
}

/**
 * @param {{ deployments: object[] }} registry
 * @param {string} network
 * @param {string} contractId
 * @returns {object|null} the most recently deployed matching entry.
 */
function getLatestDeployment(registry, network, contractId) {
  const matches = registry.deployments.filter(
    (e) => e.network === network && e.contractId === contractId,
  );
  if (matches.length === 0) return null;
  return matches.reduce((latest, e) =>
    Date.parse(e.deployedAt) > Date.parse(latest.deployedAt) ? e : latest,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    }
  }
  return args;
}

function cliHash(argv) {
  const [wasmPath] = argv;
  if (!wasmPath) {
    console.error("Usage: deploymentRegistry.js hash <wasm-file>");
    process.exit(2);
  }
  console.log(computeWasmSha256(wasmPath));
}

function cliValidate(argv) {
  const args = parseArgs(argv);
  const registryPath = args.registry || "contracts/deployments.json";
  try {
    const registry = loadRegistry(registryPath);
    console.log(
      `OK: ${registryPath} is valid (${registry.deployments.length} deployment record(s))`,
    );
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function cliRecord(argv) {
  const args = parseArgs(argv);
  const registryPath = args.registry || "contracts/deployments.json";
  const required = [
    "network",
    "contract-id",
    "git-sha",
    "wasm-sha256",
    "deployed-at",
    "identity",
    "deployer-address",
    "env",
  ];
  const missing = required.filter((f) => !args[f]);
  if (missing.length > 0) {
    console.error(`Missing required flag(s): ${missing.map((f) => `--${f}`).join(", ")}`);
    process.exit(2);
  }

  try {
    const entry = recordDeployment(registryPath, {
      network: args.network,
      contractId: args["contract-id"],
      gitSha: args["git-sha"],
      wasmSha256: args["wasm-sha256"],
      deployedAt: args["deployed-at"],
      identity: args.identity,
      deployerAddress: args["deployer-address"],
      env: args.env,
      verified: args.verified === "false" ? false : true,
      verificationDetail: args["verification-detail"] || null,
    });
    console.log(`Recorded deployment ${entry.id} in ${registryPath}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "hash":
      return cliHash(rest);
    case "validate":
      return cliValidate(rest);
    case "record":
      return cliRecord(rest);
    default:
      console.error("Usage: deploymentRegistry.js <hash|validate|record> [...args]");
      process.exit(2);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  computeWasmSha256,
  validateRegistrySchema,
  loadRegistry,
  writeRegistryAtomic,
  recordDeployment,
  getLatestDeployment,
  parseArgs,
  REQUIRED_FIELDS,
};
