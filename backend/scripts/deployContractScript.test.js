"use strict";

/**
 * Integration tests for scripts/deploy-contract.sh (issue #921).
 *
 * Spawns the real script inside an isolated fake "repo" (its own git init,
 * its own contracts/indigopay-contract dir) with fake `cargo` and `stellar`
 * executables on PATH, so these tests exercise the actual bash logic —
 * argument parsing, guardrails, registry recording — without needing a
 * real Rust toolchain or Soroban network.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

const REAL_SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "deploy-contract.sh");
const REAL_REGISTRY_HELPER = path.resolve(__dirname, "deploymentRegistry.js");
const FAKE_CONTRACT_ID = "CFAKECONTRACTID0000000000000000000000000000000";
const FAKE_DEPLOYER_ADDRESS = "GFAKEDEPLOYERADDRESS000000000000000000000000000000000";

function setupFakeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "deploy-script-test-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "backend", "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "contracts", "indigopay-contract"), { recursive: true });

  fs.copyFileSync(REAL_SCRIPT, path.join(root, "scripts", "deploy-contract.sh"));
  fs.chmodSync(path.join(root, "scripts", "deploy-contract.sh"), 0o755);
  fs.copyFileSync(
    REAL_REGISTRY_HELPER,
    path.join(root, "backend", "scripts", "deploymentRegistry.js"),
  );

  const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" };
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "README.md"), "fake repo\n");
  execFileSync("git", ["add", "."], { cwd: root, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: root, env: gitEnv });

  return root;
}

/**
 * Fake `cargo`: just materializes the WASM artifact the script expects,
 * with unique-ish bytes so repeated builds get a fresh hash if needed.
 */
function writeFakeCargo(binDir) {
  const p = path.join(binDir, "cargo");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = path.join(process.cwd(), "target", "wasm32-unknown-unknown", "release");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "indigopay_contract.wasm"), "fake-wasm-bytes-v1");
`,
  );
  fs.chmodSync(p, 0o755);
}

/**
 * Fake `stellar`: handles exactly the subcommands deploy-contract.sh calls.
 *
 * @param {string} binDir
 * @param {{ deployFails?: boolean, fetchFails?: boolean, fetchMismatch?: boolean }} [opts]
 */
function writeFakeStellar(binDir, opts = {}) {
  const { deployFails = false, fetchFails = false, fetchMismatch = false } = opts;
  const p = path.join(binDir, "stellar");
  fs.writeFileSync(
    p,
    `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const argv = process.argv.slice(2);

function flagValue(name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

if (argv[0] === "contract" && argv[1] === "deploy") {
  if (${deployFails ? "true" : "false"}) {
    process.stderr.write("simulated deploy failure\\n");
    process.exit(1);
  }
  process.stdout.write("${FAKE_CONTRACT_ID}\\n");
  process.exit(0);
}

if (argv[0] === "keys" && argv[1] === "address") {
  process.stdout.write("${FAKE_DEPLOYER_ADDRESS}\\n");
  process.exit(0);
}

if (argv[0] === "contract" && argv[1] === "fetch") {
  if (${fetchFails ? "true" : "false"}) {
    process.stderr.write("simulated RPC unavailable\\n");
    process.exit(1);
  }
  const outFile = flagValue("--out-file");
  const content = ${fetchMismatch ? '"different-wasm-bytes"' : '"fake-wasm-bytes-v1"'};
  fs.writeFileSync(outFile, content);
  process.exit(0);
}

if (argv[0] === "contract" && argv[1] === "invoke") {
  process.exit(0);
}

process.stderr.write("unhandled fake stellar invocation: " + argv.join(" ") + "\\n");
process.exit(1);
`,
  );
  fs.chmodSync(p, 0o755);
}

function runScript(root, args, { withFakeCli = false, stellarOpts } = {}) {
  const binDir = path.join(root, "fakebin");
  fs.mkdirSync(binDir, { recursive: true });
  if (withFakeCli) {
    writeFakeCargo(binDir);
    writeFakeStellar(binDir, stellarOpts);
  }

  return spawnSync(path.join(root, "scripts", "deploy-contract.sh"), args, {
    cwd: root,
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    encoding: "utf8",
    timeout: 30_000,
  });
}

function readRegistry(root) {
  const file = path.join(root, "contracts", "deployments.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

describe("deploy-contract.sh — guardrails (no fake CLI needed, fail before any tool check)", () => {
  test("aborts with no --network", () => {
    const root = setupFakeRepo();
    const result = runScript(root, []);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/--network is required/);
    expect(readRegistry(root)).toBeNull();
  });

  test("aborts on an unknown network name", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "devnet"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/Unknown network/);
  });

  test("aborts mainnet deploy without --confirm", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "mainnet", "--identity", "prod"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/requires --confirm/);
    expect(readRegistry(root)).toBeNull();
  });

  test("aborts mainnet deploy using the default testnet identity, even with --confirm", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "mainnet", "--confirm"]); // default identity: alice
    expect(result.status).toBe(2);
    expect(result.stderr).toMatch(/testnet\/example identity/);
  });
});

describe("deploy-contract.sh — dry run", () => {
  test("builds and hashes but does not deploy or write the registry", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "testnet", "--dry-run"], { withFakeCli: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Dry run complete/);
    expect(readRegistry(root)).toBeNull();
  });
});

describe("deploy-contract.sh — full deploy with verification", () => {
  test("a successful deploy with a matching on-chain hash records a verified entry", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "testnet"], { withFakeCli: true });

    expect(result.status).toBe(0);
    const registry = readRegistry(root);
    expect(registry.deployments).toHaveLength(1);
    const entry = registry.deployments[0];
    expect(entry.network).toBe("testnet");
    expect(entry.contractId).toBe("CFAKECONTRACTID0000000000000000000000000000000".trim());
    expect(entry.verified).toBe(true);
    expect(entry.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.gitSha).toMatch(/^[0-9a-f]{40}$/);
  });

  test("an on-chain hash mismatch records verified=false and exits non-zero", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "testnet"], {
      withFakeCli: true,
      stellarOpts: { fetchMismatch: true },
    });

    expect(result.status).not.toBe(0);
    const registry = readRegistry(root);
    expect(registry.deployments).toHaveLength(1);
    expect(registry.deployments[0].verified).toBe(false);
    expect(registry.deployments[0].verificationDetail).toMatch(/on-chain hash/);
  });

  test("RPC unavailable during verification reports failure rather than a fake pass", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "testnet"], {
      withFakeCli: true,
      stellarOpts: { fetchFails: true },
    });

    expect(result.status).not.toBe(0);
    const registry = readRegistry(root);
    expect(registry.deployments[0].verified).toBe(false);
    expect(registry.deployments[0].verificationDetail).toMatch(/RPC fetch failed/);
  });

  test("--skip-verify records verified=false but still exits 0 (deliberate opt-out, not a failure)", () => {
    const root = setupFakeRepo();
    const result = runScript(root, ["--network", "testnet", "--skip-verify"], {
      withFakeCli: true,
    });

    expect(result.status).toBe(0);
    const registry = readRegistry(root);
    expect(registry.deployments[0].verified).toBe(false);
    expect(registry.deployments[0].verificationDetail).toMatch(/skipped/);
  });

  test("re-deploying appends a second registry entry rather than overwriting the first", () => {
    const root = setupFakeRepo();
    runScript(root, ["--network", "testnet"], { withFakeCli: true });
    runScript(root, ["--network", "testnet"], { withFakeCli: true });

    const registry = readRegistry(root);
    expect(registry.deployments).toHaveLength(2);
  });
});
