"use strict";

const pool = require("../../db/pool");
const { getInventory } = require("./dataInventory");
const { uploadFile } = require("../storage");

const DONOR_KEY_MAP = {
  profiles: "public_key",
  donations: "donor_address",
  donation_matches: "matcher_address",
  project_ratings: "donor_address",
  device_tokens: "wallet_address",
  projection_donor_history: "donor_address",
  digest_sends: "donor_address",
  project_subscriptions: "donor_address",
  receipts: "donor_address_join_donations", // Special case
  admin_audit_log: null,
  on_chain_references: null
};

/**
 * Handles the dsr-export job from pg-boss.
 */
async function processExportJob(job) {
  const { donorAddress } = job.data;
  if (!donorAddress) throw new Error("Missing donorAddress in job data");

  const inventory = getInventory();
  const exportData = {};
  const manifest = {
    generatedAt: new Date().toISOString(),
    donorAddress,
    classes: {}
  };

  for (const item of inventory) {
    if (!item.supportsExport) {
      manifest.classes[item.name] = {
        included: false,
        action: item.action,
        explanation: item.explanation || "Not supported for export."
      };
      continue;
    }

    const keyColumn = DONOR_KEY_MAP[item.name];
    if (!keyColumn) {
      manifest.classes[item.name] = {
        included: false,
        action: item.action,
        explanation: "No mapping to donor key."
      };
      continue;
    }

    try {
      let result;
      if (keyColumn === "donor_address_join_donations") {
        result = await pool.query(
          `SELECT r.* FROM ${item.storageLocation} r JOIN donations d ON d.id = r.donation_id WHERE d.donor_address = $1`,
          [donorAddress]
        );
      } else {
        result = await pool.query(
          `SELECT * FROM ${item.storageLocation} WHERE ${keyColumn} = $1`,
          [donorAddress]
        );
      }
      
      exportData[item.name] = result.rows;
      manifest.classes[item.name] = {
        included: true,
        rowCount: result.rows.length,
        action: item.action
      };
    } catch (err) {
      // If table missing or query fails, skip gracefully
      manifest.classes[item.name] = {
        included: false,
        error: err.message
      };
    }
  }

  exportData._manifest = manifest;
  
  // Convert to JSON buffer
  const jsonBuffer = Buffer.from(JSON.stringify(exportData, null, 2), "utf8");
  const fileName = `export-${donorAddress}-${Date.now()}.json`;

  // Upload
  const uploadResult = await uploadFile(jsonBuffer, fileName, "application/json");

  // Expire in 24 hours (configurable in production)
  const expireHours = parseInt(process.env.DSR_EXPORT_EXPIRY_HOURS || "24", 10);
  const expiresAt = new Date(Date.now() + expireHours * 60 * 60 * 1000).toISOString();

  const { metrics } = require("../metrics");
  metrics.dsrExportCompleted.inc();

  // Return the result to pg-boss, which saves it in output
  return {
    url: uploadResult.url,
    backend: uploadResult.backend,
    key: uploadResult.key,
    expiresAt,
    rowCount: Object.values(manifest.classes).reduce((acc, c) => acc + (c.rowCount || 0), 0)
  };
}

module.exports = {
  processExportJob
};
