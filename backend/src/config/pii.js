"use strict";

const crypto = require("crypto");

const PII_FIELD_MAP = Object.freeze({
  analytics: ["donor_address", "email", "name", "wallet_address"],
  digest: ["donorAddress", "email", "walletAddress", "projectNames", "recentDonations"],
  exports: ["donor_address", "email", "wallet_address", "donorAddress", "walletAddress"],
});

const PII_PATTERNS = Object.freeze([
  /[A-Z2-7]{56}/g,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  /(?:\b(?:first|last|full)\s+name\b)/gi,
]);

function getPepper() {
  return process.env.PII_PEPPER || "indigopay-local-dev-pepper";
}

function hashDonorId(value) {
  if (!value || typeof value !== "string") return "redacted";
  const pepper = getPepper();
  return crypto
    .createHmac("sha256", pepper)
    .update(value.toLowerCase().trim())
    .digest("hex");
}

function redactPiiValue(field, value) {
  if (value === null || value === undefined) return value;
  const fieldName = String(field || "").toLowerCase();

  if (fieldName.includes("email")) {
    return `email-redacted-${hashDonorId(String(value)).slice(0, 12)}`;
  }

  if (fieldName.includes("donor") || fieldName.includes("wallet") || fieldName.includes("address")) {
    return hashDonorId(String(value));
  }

  if (fieldName.includes("name")) {
    return `name-redacted-${hashDonorId(String(value)).slice(0, 12)}`;
  }

  return value;
}

function scrubAnalyticsRow(row = {}) {
  const scrubbed = { ...row };
  for (const field of PII_FIELD_MAP.analytics) {
    if (Object.prototype.hasOwnProperty.call(scrubbed, field)) {
      scrubbed[field] = redactPiiValue(field, scrubbed[field]);
    }
  }
  return scrubbed;
}

function scrubDigestPayload(payload = {}) {
  const scrubbed = structuredClone(payload);

  if (scrubbed.donorAddress) {
    scrubbed.donorAddress = redactPiiValue("donor_address", scrubbed.donorAddress);
  }

  if (scrubbed.email) {
    scrubbed.email = redactPiiValue("email", scrubbed.email);
  }

  if (scrubbed.walletAddress) {
    scrubbed.walletAddress = redactPiiValue("wallet_address", scrubbed.walletAddress);
  }

  if (Array.isArray(scrubbed.projectNames)) {
    scrubbed.projectNames = scrubbed.projectNames.map((entry) =>
      typeof entry === "string" ? `project-redacted-${hashDonorId(entry).slice(0, 8)}` : entry,
    );
  }

  if (Array.isArray(scrubbed.recentDonations)) {
    scrubbed.recentDonations = scrubbed.recentDonations.map((entry) => {
      if (!entry || typeof entry !== "object") return entry;
      const copy = { ...entry };
      if (copy.projectName) {
        copy.projectName = `project-redacted-${hashDonorId(String(copy.projectName)).slice(0, 8)}`;
      }
      return copy;
    });
  }

  return scrubbed;
}

function scrubPiiText(value) {
  if (typeof value !== "string") return value;
  let redacted = value;
  for (const pattern of PII_PATTERNS) {
    redacted = redacted.replace(pattern, "[REDACTED]");
  }
  return redacted;
}

module.exports = {
  PII_FIELD_MAP,
  PII_PATTERNS,
  hashDonorId,
  redactPiiValue,
  scrubAnalyticsRow,
  scrubDigestPayload,
  scrubPiiText,
};
