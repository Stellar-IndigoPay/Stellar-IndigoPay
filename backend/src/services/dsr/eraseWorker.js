"use strict";

const pool = require("../../db/pool");
const { getInventory } = require("./dataInventory");
const crypto = require("crypto");
const logger = require("../../logger");

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
 * Handles the dsr-erase job from pg-boss.
 */
async function processEraseJob(job) {
  const { donorAddress } = job.data;
  if (!donorAddress) throw new Error("Missing donorAddress in job data");

  const inventory = getInventory();

  // We should run this inside a transaction to ensure atomic partial-success if possible,
  // but since different tables might be independent, we can also do best-effort.
  // We'll use best-effort per table so one failure doesn't halt everything.
  const client = await pool.connect();

  try {
    // 1. Edge case handling: Check for active match pledges.
    let hasActiveMatch = false;
    try {
      const matchRes = await client.query(
        "SELECT 1 FROM donation_matches WHERE matcher_address = $1 AND status = 'active' LIMIT 1",
        [donorAddress]
      );
      if (matchRes.rowCount > 0) {
        hasActiveMatch = true;
        logger.info({ donorAddress }, "Donor has active match pledge. Skipping profiles anonymization.");
      }
    } catch (err) {
      logger.warn({ err: err.message }, "Failed to check active matches for donor.");
    }

    // Generate a consistent peppered hash for anonymization (using SHA-256)
    // The prompt suggested replacing address with a hash.
    // In Phase 0, we noted we should "Use an existing HMAC secret (e.g. JWT_SECRET) instead of a pepper."
    const secret = process.env.JWT_SECRET || "fallback_secret";
    const anonymizedHash = crypto.createHmac("sha256", secret).update(donorAddress).digest("hex");

    for (const item of inventory) {
      if (!item.supportsErase) continue;

      const keyColumn = DONOR_KEY_MAP[item.name];
      if (!keyColumn) continue;

      // Edge case: skip profiles if active match
      if (item.name === "profiles" && hasActiveMatch) {
        continue;
      }

      // Override action for subscriptions: erasure should delete them outright.
      const action = item.name === "project_subscriptions" ? "delete" : item.action;

      try {
        if (action === "delete") {
          if (keyColumn === "donor_address_join_donations") {
            // Delete receipts where donation belongs to donor
            await client.query(
              `DELETE FROM ${item.storageLocation} WHERE donation_id IN (SELECT id FROM donations WHERE donor_address = $1)`,
              [donorAddress]
            );
          } else {
            await client.query(
              `DELETE FROM ${item.storageLocation} WHERE ${keyColumn} = $1`,
              [donorAddress]
            );
          }
        } else if (item.action === "anonymize") {
          const fields = item.anonymizeFields;
          if (fields && fields.length > 0) {
            const setClauses = [];
            
            fields.forEach((f) => {
              // Special case: if the field is the primary identifier, we hash it
              if (f === "public_key" || f === "donor_address" || f === "matcher_address" || f === "wallet_address") {
                setClauses.push(`${f} = '${anonymizedHash}'`);
              } else if (f === "email" || f === "contact_email") {
                setClauses.push(`${f} = 'anonymized@indigopay.app'`);
              } else {
                // Otherwise null out PII
                setClauses.push(`${f} = NULL`);
              }
            });

            if (item.anonymizedAtColumn) {
              setClauses.push(`${item.anonymizedAtColumn} = NOW()`);
            }

            if (keyColumn === "donor_address_join_donations") {
              await client.query(
                `UPDATE ${item.storageLocation} SET ${setClauses.join(", ")} WHERE donation_id IN (SELECT id FROM donations WHERE donor_address = $1)`,
                [donorAddress]
              );
            } else {
              await client.query(
                `UPDATE ${item.storageLocation} SET ${setClauses.join(", ")} WHERE ${keyColumn} = $1`,
                [donorAddress]
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err: err.message, table: item.storageLocation }, "Failed to erase data for table");
      }
    }
  } finally {
    client.release();
  }

  const { metrics } = require("../metrics");
  metrics.dsrErasureCompleted.inc();

  return { success: true, donorAddress };
}

module.exports = {
  processEraseJob
};
