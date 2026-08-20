"use strict";

/* eslint-disable security/detect-non-literal-fs-filename */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { getSigningSecret } = require("./signingSecretProvider");

describe("signingSecretProvider", () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "signing-secrets-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loads the oracle admin signer from a managed secret file", async () => {
    const secretPath = path.join(tmpDir, "oracle");
    fs.writeFileSync(secretPath, "SADMIN\n");

    await expect(
      getSigningSecret("oracleAdmin", { env: { ORACLE_ADMIN_SECRET_FILE: secretPath } }),
    ).resolves.toBe("SADMIN");
  });

  test("loads the recurring keeper signer from a JSON secret bundle", async () => {
    const secretPath = path.join(tmpDir, "signers.json");
    fs.writeFileSync(secretPath, JSON.stringify({ recurring_signer_secret: "SKEEPER" }));

    await expect(
      getSigningSecret("recurringKeeper", { env: { MANAGED_SIGNER_SECRETS_FILE: secretPath } }),
    ).resolves.toBe("SKEEPER");
  });

  test("rejects direct production environment secrets", async () => {
    await expect(
      getSigningSecret("oracleAdmin", {
        env: { NODE_ENV: "production", ORACLE_ADMIN_SECRET: "SADMIN" },
      }),
    ).rejects.toThrow("managed secret file");
  });

  test("allows legacy direct env secrets only for tests and development", async () => {
    await expect(
      getSigningSecret("recurringKeeper", {
        env: { NODE_ENV: "test", KEEPER_SECRET: "SKEEPER" },
      }),
    ).resolves.toBe("SKEEPER");
  });
});
