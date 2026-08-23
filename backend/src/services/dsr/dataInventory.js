"use strict";

const retentionPolicies = require("../../config/retentionPolicies");

// The known data classes touching donor data as per the DSR requirements.
const DONOR_DATA_CLASSES = [
  { name: "profiles", table: "profiles" },
  { name: "donations", table: "donations" },
  { name: "matches", table: "donation_matches" },
  { name: "preferences", table: "project_ratings" },
  { name: "push_tokens", table: "device_tokens" },
  { name: "analytics_identifiers", table: "projection_donor_history" },
  { name: "digests", table: "digest_sends" },
  { name: "receipts", table: "donation_receipts" },
  { name: "audit_entries", table: "admin_audit_log" },
  { name: "on_chain_references", table: "on_chain_references" },
  { name: "project_subscriptions", table: "project_subscriptions" }
];

/**
 * Builds the data inventory based on retentionPolicies.js.
 * Fails loudly if a class is missing from retention policies and is not out_of_scope.
 */
function getInventory() {
  const inventory = [];

  for (const dataClass of DONOR_DATA_CLASSES) {
    if (dataClass.name === "donations" || dataClass.name === "on_chain_references") {
      inventory.push({
        name: dataClass.name,
        storageLocation: dataClass.table,
        supportsExport: true,
        supportsErase: false,
        action: "out_of_scope",
        explanation: "On-chain donation data and references are immutable and out of scope for erasure."
      });
      continue;
    }

    if (dataClass.name === "audit_entries") {
      inventory.push({
        name: dataClass.name,
        storageLocation: dataClass.table,
        supportsExport: false,
        supportsErase: false,
        action: "out_of_scope",
        explanation: "Audit entries are preserved for compliance and are out of scope for donor erasure."
      });
      continue;
    }

    // Look for a policy targeting this table
    const policy = retentionPolicies.policies.find(p => p.table === dataClass.table);

    if (!policy) {
      throw new Error(`Data class "${dataClass.name}" (table: ${dataClass.table}) is missing from retentionPolicies.js. Cannot determine erasure action.`);
    }

    inventory.push({
      name: dataClass.name,
      storageLocation: dataClass.table,
      supportsExport: true,
      supportsErase: true,
      action: policy.strategy, // 'delete' or 'anonymize'
      policyName: policy.name,
      anonymizeFields: policy.anonymizeFields || [],
      anonymizedAtColumn: policy.anonymizedAtColumn || null
    });
  }

  return inventory;
}

module.exports = {
  DONOR_DATA_CLASSES,
  getInventory
};
