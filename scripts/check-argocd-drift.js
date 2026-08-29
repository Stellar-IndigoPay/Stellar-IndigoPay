#!/usr/bin/env node
/**
 * scripts/check-argocd-drift.js
 *
 * Checks ArgoCD application synchronization status and health.
 * Operates against live ArgoCD REST API or fixture data (--fixture <file> / --json <str>).
 *
 * Usage:
 *   node scripts/check-argocd-drift.js [--fixture path/to/fixture.json] [--appName stellar-indigopay]
 *
 * Exit code 0 if Synced and Healthy, 1 if OutOfSync, Degraded, or API error.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

/**
 * Parse ArgoCD Application status payload.
 *
 * @param {object} appDoc
 * @returns {{synced: boolean, healthy: boolean, syncStatus: string, healthStatus: string, driftedResources: object[], errors: string[]}}
 */
function evaluateArgoCDStatus(appDoc) {
  const errors = [];
  if (!appDoc || typeof appDoc !== "object") {
    return {
      synced: false,
      healthy: false,
      syncStatus: "Unknown",
      healthStatus: "Unknown",
      driftedResources: [],
      errors: ["Invalid or empty ArgoCD application payload."],
    };
  }

  const status = appDoc.status || {};
  const sync = status.sync || {};
  const health = status.health || {};

  const syncStatus = sync.status || "Unknown";
  const healthStatus = health.status || "Unknown";

  const synced = syncStatus === "Synced";
  const healthy = healthStatus === "Healthy";

  const resources = status.resources || [];
  const driftedResources = resources.filter(
    (res) => res.status === "OutOfSync" || res.health && res.health.status === "Degraded"
  );

  if (!synced) {
    errors.push(`Application is OutOfSync (sync status: ${syncStatus}).`);
  }
  if (!healthy) {
    errors.push(`Application health is not Healthy (health status: ${healthStatus}).`);
  }

  return {
    synced,
    healthy,
    syncStatus,
    healthStatus,
    driftedResources,
    errors,
  };
}

/**
 * Fetch application status from ArgoCD REST API.
 *
 * @param {string} serverUrl
 * @param {string} appName
 * @param {string} token
 * @returns {Promise<object>}
 */
function fetchArgoCDApp(serverUrl, appName, token) {
  return new Promise((resolve, reject) => {
    const url = `${serverUrl.replace(/\/$/, "")}/api/v1/applications/${appName}`;
    const client = url.startsWith("https") ? https : http;

    const options = {
      headers: {
        Accept: "application/json",
      },
    };
    if (token) {
      options.headers.Authorization = `Bearer ${token}`;
    }

    const req = client.get(url, options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`ArgoCD API HTTP ${res.statusCode}: ${data}`));
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse ArgoCD API JSON response: ${e.message}`));
        }
      });
    });

    req.on("error", (err) => reject(new Error(`ArgoCD API connection error: ${err.message}`)));
    req.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  let fixturePath = null;
  let jsonStr = null;
  let appName = process.env.ARGOCD_APP_NAME || "stellar-indigopay";
  let serverUrl = process.env.ARGOCD_SERVER_URL || "https://localhost:8080";
  let token = process.env.ARGOCD_AUTH_TOKEN || "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--fixture" && args[i + 1]) {
      fixturePath = args[i + 1];
      i++;
    } else if (args[i] === "--json" && args[i + 1]) {
      jsonStr = args[i + 1];
      i++;
    } else if (args[i] === "--appName" && args[i + 1]) {
      appName = args[i + 1];
      i++;
    }
  }

  let appDoc;

  if (fixturePath) {
    const fullPath = path.resolve(fixturePath);
    console.log(`\n🔍 Checking ArgoCD drift using fixture: ${fullPath}...\n`);
    try {
      appDoc = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
    } catch (e) {
      console.error(`❌ Failed to read fixture file: ${e.message}`);
      process.exit(1);
    }
  } else if (jsonStr) {
    try {
      appDoc = JSON.parse(jsonStr);
    } catch (e) {
      console.error(`❌ Failed to parse --json argument: ${e.message}`);
      process.exit(1);
    }
  } else {
    console.log(`\n🔍 Fetching ArgoCD application "${appName}" status from ${serverUrl}...\n`);
    try {
      appDoc = await fetchArgoCDApp(serverUrl, appName, token);
    } catch (e) {
      console.error(`❌ ArgoCD API Error: ${e.message}`);
      console.error(`\nRunbook: docs/runbooks/gitops-argocd-drift.md\n`);
      process.exit(1);
    }
  }

  const result = evaluateArgoCDStatus(appDoc);

  console.log(`📊 Application: ${appName}`);
  console.log(`   Sync Status:   ${result.syncStatus}`);
  console.log(`   Health Status: ${result.healthStatus}`);

  if (result.driftedResources.length > 0) {
    console.log(`\n⚠️ Drifted / Unhealthy Resources (${result.driftedResources.length}):`);
    for (const res of result.driftedResources) {
      console.log(
        `   - ${res.kind}/${res.name} (Namespace: ${res.namespace || "default"}) | Sync: ${res.status || "Unknown"} | Health: ${(res.health && res.health.status) || "N/A"}`
      );
    }
  }

  if (result.synced && result.healthy) {
    console.log(`\n✅ ArgoCD Application "${appName}" is Synced and Healthy. No drift detected.\n`);
    process.exit(0);
  } else {
    console.error(`\n❌ ArgoCD Application "${appName}" has active drift or degraded health!`);
    console.error(`   Runbook: docs/runbooks/gitops-argocd-drift.md\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateArgoCDStatus,
  fetchArgoCDApp,
};
