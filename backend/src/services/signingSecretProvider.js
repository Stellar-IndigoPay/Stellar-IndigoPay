"use strict";

/* eslint-disable security/detect-non-literal-fs-filename, security/detect-object-injection */

const fs = require("fs/promises");
const path = require("path");

const SIGNER_CONFIG = Object.freeze({
  oracleAdmin: {
    displayName: "oracle admin signer",
    fileEnvVars: ["ORACLE_ADMIN_SECRET_FILE", "MANAGED_SIGNER_SECRETS_FILE"],
    legacyEnvVar: "ORACLE_ADMIN_SECRET",
    jsonKeys: ["ORACLE_ADMIN_SECRET", "oracle_admin_secret"],
  },
  recurringKeeper: {
    displayName: "recurring keeper signer",
    fileEnvVars: ["KEEPER_SECRET_FILE", "RECURRING_SIGNER_SECRET_FILE", "MANAGED_SIGNER_SECRETS_FILE"],
    legacyEnvVar: "KEEPER_SECRET",
    jsonKeys: ["RECURRING_SIGNER_SECRET", "recurring_signer_secret", "KEEPER_SECRET"],
  },
});

function isLocalRuntime(env = process.env) {
  return ["test", "development"].includes(env.NODE_ENV);
}

async function readFileSecret(filePath, config) {
  const raw = await fs.readFile(path.resolve(filePath), "utf8");
  const trimmed = raw.trim();
  if (!trimmed) return "";

  if (!filePath.endsWith(".json")) {
    return trimmed;
  }

  const parsed = JSON.parse(trimmed);
  for (const key of config.jsonKeys) {
    if (typeof parsed[key] === "string" && parsed[key].trim()) {
      return parsed[key].trim();
    }
  }
  return "";
}

async function getSigningSecret(role, options = {}) {
  const env = options.env || process.env;
  const config = SIGNER_CONFIG[role];
  if (!config) {
    throw new Error(`Unknown signing secret role: ${role}`);
  }

  for (const fileEnvVar of config.fileEnvVars) {
    const filePath = env[fileEnvVar];
    if (!filePath) continue;
    const secret = await readFileSecret(filePath, config);
    if (!secret) {
      throw new Error(`${fileEnvVar} did not contain ${config.displayName} material`);
    }
    return secret;
  }

  if (isLocalRuntime(env) && env[config.legacyEnvVar]) {
    return env[config.legacyEnvVar].trim();
  }

  throw new Error(
    `${config.displayName} must be loaded from a managed secret file (` +
      `${config.fileEnvVars.join(" or ")}); direct ${config.legacyEnvVar} env loading is only allowed in test/development`,
  );
}

module.exports = {
  SIGNER_CONFIG,
  getSigningSecret,
};
