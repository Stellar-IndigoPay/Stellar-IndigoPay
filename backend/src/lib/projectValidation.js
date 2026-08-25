"use strict";

/**
 * projectValidation.js
 * Shared validation rules for project registration
 * Uses Zod to match backend/src/validators/schemas.js
 */

const { z } = require("zod");

// ── Regex constants (mirrored from schemas.js) ──────────────────────────────
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const PROJECT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

// ── Zod schemas ───────────────────────────────────────────────────────────────

const projectIdSchema = z
  .string()
  .regex(PROJECT_ID_RE, "project_id must be alphanumeric, underscore, or hyphen (max 64 chars)")
  .min(1, "project_id is required");

const nameSchema = z
  .string()
  .min(3, "name must be at least 3 characters")
  .max(100, "name must be at most 100 characters");

const walletSchema = z
  .string()
  .regex(STELLAR_ADDRESS_RE, "wallet must be a valid Stellar address starting with G (56 chars)");

const co2PerXlmSchema = z
  .number()
  .min(0, "co2_per_xlm must be at least 0")
  .max(1000000, "co2_per_xlm must be at most 1,000,000")
  .finite("co2_per_xlm must be a finite number");

// ── Full project schema ───────────────────────────────────────────────────────

const projectSchema = z.object({
  project_id: projectIdSchema,
  name: nameSchema,
  wallet: walletSchema,
  co2_per_xlm: co2PerXlmSchema,
});

// ── Validation functions ──────────────────────────────────────────────────────

function validateProject(data) {
  try {
    const validated = projectSchema.parse(data);
    return { valid: true, data: validated };
  } catch (error) {
    if (error.errors) {
      const errors = error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
        value: e.input,
      }));
      return { valid: false, errors };
    }
    return { valid: false, errors: [{ field: 'unknown', message: error.message }] };
  }
}

function validateProjectId(projectId) {
  try {
    projectIdSchema.parse(projectId);
    return true;
  } catch {
    return false;
  }
}

function validateWallet(wallet) {
  try {
    walletSchema.parse(wallet);
    return true;
  } catch {
    return false;
  }
}

function validateName(name) {
  try {
    nameSchema.parse(name);
    return true;
  } catch {
    return false;
  }
}

function validateCo2PerXlm(co2) {
  try {
    co2PerXlmSchema.parse(co2);
    return true;
  } catch {
    return false;
  }
}

function sanitizeName(name) {
  return name ? name.trim().replace(/\s+/g, ' ') : '';
}

function formatValidationErrors(errors) {
  if (!errors || errors.length === 0) return '';

  const lines = ['\n❌ Validation errors:'];
  for (const err of errors) {
    lines.push(`  - ${err.field}: ${err.message}`);
    if (err.value !== undefined && err.value !== null) {
      lines.push(`    (got: "${err.value}")`);
    }
  }
  return lines.join('\n');
}

// ── Export ────────────────────────────────────────────────────────────────────

module.exports = {
  // Schemas
  projectSchema,
  projectIdSchema,
  nameSchema,
  walletSchema,
  co2PerXlmSchema,

  // Validation functions
  validateProject,
  validateProjectId,
  validateWallet,
  validateName,
  validateCo2PerXlm,

  // Helpers
  sanitizeName,
  formatValidationErrors,

  // Constants
  PROJECT_ID_RE,
  STELLAR_ADDRESS_RE,
};
