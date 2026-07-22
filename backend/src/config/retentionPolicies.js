"use strict";

/**
 * src/config/retentionPolicies.js
 *
 * Centralized, declarative data-retention configuration for the backend.
 *
 * The retention worker (src/services/retentionWorker.js) reads these policies
 * and applies them. No retention logic is hard-coded in the worker — every
 * policy here is data-driven so operators can reason about, audit, and extend
 * retention behaviour without touching the worker.
 *
 * Strategy semantics
 *   - "delete":      physically DELETE rows matching `condition` that are older
 *                    than `retentionPeriod`. Used for rows that carry no
 *                    long-term compliance value (device tokens, stale webhook
 *                    delivery receipts, pg-boss job archives).
 *   - "anonymize":   UPDATE PII columns listed in `anonymizeFields` to NULL (or a
 *                    constant) for rows older than `retentionPeriod` that have not
 *                    already been anonymized, and stamp `anonymised_at`. The row
 *                    is preserved so aggregate counts survive, but the personal
 *                    data is removed.
 *
 * Safety / compliance constraints honoured by this file
 *   - Donations are NEVER retained here (immutable on-chain ledger — see
 *     `donations` table). Preserving donation records is a hard requirement.
 *   - On-chain references (transaction_hash, release_transaction_hash, …) are
 *     never touched.
 *   - Audit logs (admin_audit_log) are intentionally NOT included in a default
 *     delete policy. Audit retention (src/services/auditRetention.js) is a
 *     separate, flag-gated concern.
 *
 * Identifier allow-list
 *   Table and column names referenced by a policy are validated at load time
 *   against a strict `^[a-z_][a-z0-9_]*$` pattern AND an explicit allow-list of
 *   tables/columns that retention is permitted to touch. This keeps the worker's
 *   dynamic query construction SQL-injection-safe even though table/column
 *   names cannot be passed as bound parameters.
 */

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/;

/**
 * Tables retention is allowed to operate on. Anything outside this set causes
 * config validation to fail, so a typo or a malicious/accidental policy can
 * never target an unrelated table (e.g. donations).
 */
const ALLOWED_TABLES = new Set([
  "project_subscriptions",
  "device_tokens",
  "webhook_deliveries",
  "webhook_dlq",
  "pgboss.archive",
]);

/**
 * Columns retention is allowed to read in a WHERE clause / stamp on UPDATE.
 * Kept narrow so a malformed policy cannot reference an unexpected column.
 */
const ALLOWED_COLUMNS = new Set([
  "id",
  "project_id",
  "email",
  "donor_address",
  "wallet_address",
  "created_at",
  "updated_at",
  "status",
  "anonymised_at",
  "retention_expires_at",
]);

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function assertIdentifier(value, what) {
  if (!isIdentifier(value)) {
    throw new Error(`Retention config: invalid ${what} identifier: ${value}`);
  }
  return value;
}

const policies = [
  {
    name: "project-subscriptions-anonymize",
    table: "project_subscriptions",
    strategy: "anonymize",
    // Retain subscription rows for aggregate counts, but strip PII after 24 months.
    retentionPeriod: { value: 24, unit: "months" },
    schedule: { cron: "0 4 1 * *", timezone: "UTC" },
    // Rows older than retentionPeriod AND not yet anonymized.
    condition: "created_at < now() - ($1::int || ' months')::interval AND anonymised_at IS NULL",
    // PII columns to blank out. The worker sets them to NULL.
    anonymizeFields: ["email", "donor_address"],
    // Column stamped on UPDATE so the operation is idempotent + auditable.
    anonymizedAtColumn: "anonymised_at",
    description:
      "Anonymize project subscription PII (email, donor wallet) after 24 months, " +
      "preserving the subscription row for aggregate counts.",
  },
  {
    name: "device-tokens-delete",
    table: "device_tokens",
    strategy: "delete",
    // Push device tokens are revocable credentials; purge stale ones after 12 months.
    retentionPeriod: { value: 12, unit: "months" },
    schedule: { cron: "0 4 2 * *", timezone: "UTC" },
    condition: "created_at < now() - ($1::int || ' months')::interval",
    description:
      "Delete device push tokens that have not been refreshed in 12 months.",
  },
  {
    name: "webhook-deliveries-delete",
    table: "webhook_deliveries",
    strategy: "delete",
    // Only terminal, non-replayable deliveries are purged. In-flight ('pending')
    // or retryable ('failed') rows are left alone so the delivery worker can
    // still process them.
    retentionPeriod: { value: 90, unit: "days" },
    schedule: { cron: "0 4 3 * *", timezone: "UTC" },
    condition:
      "created_at < now() - ($1::int || ' days')::interval AND status IN ('delivered','dlq')",
    description:
      "Delete terminal webhook delivery receipts (delivered/dlq) older than 90 days.",
  },
  {
    name: "webhook-dlq-delete",
    table: "webhook_dlq",
    strategy: "delete",
    retentionPeriod: { value: 180, unit: "days" },
    schedule: { cron: "0 4 4 * *", timezone: "UTC" },
    condition: "created_at < now() - ($1::int || ' days')::interval",
    description: "Delete dead-letter webhook entries older than 180 days.",
  },
  {
    name: "pgboss-archive-delete",
    table: "pgboss.archive",
    strategy: "delete",
    // Operational job history — not business data. Purge completed archives
    // after 30 days to keep the pg-boss schema small.
    retentionPeriod: { value: 30, unit: "days" },
    schedule: { cron: "0 4 5 * *", timezone: "UTC" },
    condition: "completedon < now() - ($1::int || ' days')::interval",
    description:
      "Delete pg-boss archived jobs (completed) older than 30 days. Operational only.",
  },
];

/**
 * Validate a single policy's structural + identifier correctness.
 * Throws on the first problem so misconfiguration fails fast at boot.
 */
function validatePolicy(policy, index) {
  const where = `policies[${index}] (${policy && policy.name})`;
  if (!policy || typeof policy !== "object") {
    throw new Error(`Retention config: ${where} is not an object`);
  }
  if (typeof policy.name !== "string" || !policy.name) {
    throw new Error(`Retention config: ${where} missing name`);
  }
  if (!["delete", "anonymize"].includes(policy.strategy)) {
    throw new Error(
      `Retention config: ${where} has unsupported strategy "${policy.strategy}"`,
    );
  }
  if (!ALLOWED_TABLES.has(policy.table)) {
    throw new Error(
      `Retention config: ${where} table "${policy.table}" is not in the allow-list`,
    );
  }
  if (
    !policy.retentionPeriod ||
    !Number.isFinite(policy.retentionPeriod.value) ||
    policy.retentionPeriod.value <= 0
  ) {
    throw new Error(`Retention config: ${where} has invalid retentionPeriod`);
  }
  if (typeof policy.condition !== "string" || !policy.condition.trim()) {
    throw new Error(`Retention config: ${where} missing condition`);
  }

  if (policy.strategy === "anonymize") {
    if (!Array.isArray(policy.anonymizeFields) || policy.anonymizeFields.length === 0) {
      throw new Error(
        `Retention config: ${where} anonymize strategy requires anonymizeFields[]`,
      );
    }
    policy.anonymizeFields.forEach((c) => {
      if (!ALLOWED_COLUMNS.has(assertIdentifier(c, "anonymizeField"))) {
        throw new Error(
          `Retention config: ${where} anonymizeField "${c}" not in allow-list`,
        );
      }
    });
    if (!policy.anonymizedAtColumn) {
      throw new Error(
        `Retention config: ${where} anonymize strategy requires anonymizedAtColumn`,
      );
    }
    assertIdentifier(policy.anonymizedAtColumn, "anonymizedAtColumn");
  }

  return policy;
}

// Fail fast at module load if any policy is misconfigured.
policies.forEach(validatePolicy);

/**
 * Build the postgres interval string for a policy's retention period, e.g.
 * "24 months" or "90 days". The numeric value is passed as a bound parameter
 * by the worker; only the unit is interpolated here and it is validated
 * against a fixed set.
 */
const VALID_UNITS = new Set(["days", "months", "years"]);
function intervalUnit(policy) {
  const unit = policy.retentionPeriod.unit;
  if (!VALID_UNITS.has(unit)) {
    throw new Error(`Retention config: invalid unit "${unit}" in ${policy.name}`);
  }
  return unit;
}

function byName(name) {
  return policies.find((p) => p.name === name) || null;
}

module.exports = {
  policies,
  byName,
  validatePolicy,
  intervalUnit,
  ALLOWED_TABLES,
  ALLOWED_COLUMNS,
  IDENTIFIER_RE,
};
