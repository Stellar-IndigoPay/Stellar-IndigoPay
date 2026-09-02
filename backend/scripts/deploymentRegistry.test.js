"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  computeWasmSha256,
  validateRegistrySchema,
  loadRegistry,
  writeRegistryAtomic,
  recordDeployment,
  getLatestDeployment,
  parseArgs,
} = require("./deploymentRegistry");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "deployment-registry-test-"));
}

function validEntry(overrides = {}) {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    network: "testnet",
    contractId: "CABC123",
    gitSha: "a".repeat(40),
    wasmSha256: "b".repeat(64),
    deployedAt: "2026-01-01T00:00:00.000Z",
    identity: "deployer",
    deployerAddress: "GDEPLOYER",
    env: "ci",
    verified: true,
    verificationDetail: null,
    ...overrides,
  };
}

describe("computeWasmSha256", () => {
  test("matches a manually computed sha256 of the file contents", () => {
    const dir = tmpDir();
    const file = path.join(dir, "test.wasm");
    fs.writeFileSync(file, "not-really-wasm-bytes");

    const expected = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");

    expect(computeWasmSha256(file)).toBe(expected);
  });

  test("different contents produce different hashes", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.wasm");
    const b = path.join(dir, "b.wasm");
    fs.writeFileSync(a, "content-a");
    fs.writeFileSync(b, "content-b");

    expect(computeWasmSha256(a)).not.toBe(computeWasmSha256(b));
  });
});

describe("validateRegistrySchema", () => {
  test("accepts a well-formed registry", () => {
    expect(() => validateRegistrySchema({ deployments: [validEntry()] })).not.toThrow();
  });

  test("accepts an empty registry", () => {
    expect(() => validateRegistrySchema({ deployments: [] })).not.toThrow();
  });

  test("rejects a non-object / missing deployments array", () => {
    expect(() => validateRegistrySchema(null)).toThrow(/deployments.*array/i);
    expect(() => validateRegistrySchema({})).toThrow(/deployments.*array/i);
  });

  test("rejects an entry missing a required field", () => {
    const entry = validEntry();
    delete entry.gitSha;
    expect(() => validateRegistrySchema({ deployments: [entry] })).toThrow(/gitSha/);
  });

  test("rejects an entry with an empty-string required field", () => {
    expect(() =>
      validateRegistrySchema({ deployments: [validEntry({ wasmSha256: "" })] }),
    ).toThrow(/wasmSha256/);
  });

  test("rejects a malformed wasmSha256", () => {
    expect(() =>
      validateRegistrySchema({ deployments: [validEntry({ wasmSha256: "not-a-hash" })] }),
    ).toThrow(/wasmSha256/);
  });

  test("rejects a malformed gitSha", () => {
    expect(() =>
      validateRegistrySchema({ deployments: [validEntry({ gitSha: "zzz" })] }),
    ).toThrow(/gitSha/);
  });

  test("rejects an invalid deployedAt timestamp", () => {
    expect(() =>
      validateRegistrySchema({ deployments: [validEntry({ deployedAt: "not-a-date" })] }),
    ).toThrow(/deployedAt/);
  });

  test("rejects a non-boolean verified field", () => {
    expect(() =>
      validateRegistrySchema({ deployments: [validEntry({ verified: "yes" })] }),
    ).toThrow(/verified/);
  });

  test("reports every violation in one pass, not just the first", () => {
    const entry = validEntry({ wasmSha256: "bad", gitSha: "bad" });
    delete entry.identity;
    try {
      validateRegistrySchema({ deployments: [entry] });
      throw new Error("expected validateRegistrySchema to throw");
    } catch (err) {
      expect(err.message).toMatch(/identity/);
      expect(err.message).toMatch(/wasmSha256/);
      expect(err.message).toMatch(/gitSha/);
    }
  });
});

describe("loadRegistry", () => {
  test("returns an empty registry when the file does not exist", () => {
    const dir = tmpDir();
    const registry = loadRegistry(path.join(dir, "does-not-exist.json"));
    expect(registry).toEqual({ deployments: [] });
  });

  test("loads and validates an existing file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    fs.writeFileSync(file, JSON.stringify({ deployments: [validEntry()] }));

    const registry = loadRegistry(file);
    expect(registry.deployments).toHaveLength(1);
  });

  test("throws on invalid JSON", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    fs.writeFileSync(file, "{ not json");
    expect(() => loadRegistry(file)).toThrow(/not valid JSON/);
  });

  test("throws on a file that fails schema validation", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    fs.writeFileSync(file, JSON.stringify({ deployments: [{}] }));
    expect(() => loadRegistry(file)).toThrow(/schema violations/);
  });
});

describe("writeRegistryAtomic", () => {
  test("writes valid JSON that round-trips through loadRegistry", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    const registry = { deployments: [validEntry()] };

    writeRegistryAtomic(file, registry);

    expect(loadRegistry(file)).toEqual(registry);
  });

  test("never leaves a temp file behind on success", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    writeRegistryAtomic(file, { deployments: [] });

    const entries = fs.readdirSync(dir);
    expect(entries).toEqual(["deployments.json"]);
  });

  test("refuses to write an invalid registry", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    expect(() => writeRegistryAtomic(file, { deployments: [{}] })).toThrow(
      /schema violations/,
    );
    expect(fs.existsSync(file)).toBe(false);
  });

  test("creates the parent directory if it does not exist", () => {
    const dir = tmpDir();
    const file = path.join(dir, "nested", "deployments.json");
    writeRegistryAtomic(file, { deployments: [] });
    expect(fs.existsSync(file)).toBe(true);
  });
});

describe("recordDeployment", () => {
  test("appends a new entry with a generated id and default verified=true", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");

    const entry = recordDeployment(file, {
      network: "testnet",
      contractId: "CNEW",
      gitSha: "c".repeat(40),
      wasmSha256: "d".repeat(64),
      deployedAt: new Date().toISOString(),
      identity: "deployer",
      deployerAddress: "GDEPLOYER",
      env: "ci",
    });

    expect(entry.id).toBeTruthy();
    expect(entry.verified).toBe(true);

    const registry = loadRegistry(file);
    expect(registry.deployments).toHaveLength(1);
    expect(registry.deployments[0].contractId).toBe("CNEW");
  });

  test("re-deploying the same contract id appends a second entry rather than overwriting", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    const base = {
      network: "testnet",
      contractId: "CSAME",
      gitSha: "e".repeat(40),
      identity: "deployer",
      deployerAddress: "GDEPLOYER",
      env: "ci",
    };

    recordDeployment(file, {
      ...base,
      wasmSha256: "1".repeat(64),
      deployedAt: "2026-01-01T00:00:00.000Z",
    });
    recordDeployment(file, {
      ...base,
      wasmSha256: "2".repeat(64),
      deployedAt: "2026-01-02T00:00:00.000Z",
    });

    const registry = loadRegistry(file);
    expect(registry.deployments).toHaveLength(2);
  });

  test("rejects a record missing a required field before writing anything", () => {
    const dir = tmpDir();
    const file = path.join(dir, "deployments.json");
    expect(() =>
      recordDeployment(file, {
        network: "testnet",
        // contractId omitted
        gitSha: "f".repeat(40),
        wasmSha256: "0".repeat(64),
        deployedAt: new Date().toISOString(),
        identity: "deployer",
        deployerAddress: "GDEPLOYER",
        env: "ci",
      }),
    ).toThrow(/contractId/);
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe("getLatestDeployment", () => {
  test("returns the most recent entry for a given network+contractId", () => {
    const registry = {
      deployments: [
        validEntry({ id: "1", deployedAt: "2026-01-01T00:00:00.000Z", wasmSha256: "1".repeat(64) }),
        validEntry({ id: "2", deployedAt: "2026-01-03T00:00:00.000Z", wasmSha256: "2".repeat(64) }),
        validEntry({ id: "3", deployedAt: "2026-01-02T00:00:00.000Z", wasmSha256: "3".repeat(64) }),
      ],
    };

    const latest = getLatestDeployment(registry, "testnet", "CABC123");
    expect(latest.id).toBe("2");
  });

  test("returns null when no entry matches", () => {
    const registry = { deployments: [validEntry()] };
    expect(getLatestDeployment(registry, "mainnet", "CDOES_NOT_EXIST")).toBeNull();
  });
});

describe("parseArgs", () => {
  test("parses --flag value pairs and boolean flags", () => {
    expect(parseArgs(["--network", "testnet", "--confirm", "--identity", "alice"])).toEqual({
      network: "testnet",
      confirm: true,
      identity: "alice",
    });
  });
});
