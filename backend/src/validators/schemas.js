/**
 * src/validators/schemas.js
 *
 * Shared Zod-based validation schemas and reusable validators.
 *
 * Reusable validators:
 *   - stellarAddress  — Stellar public key (G…, base-32)
 *   - transactionHash — 64-char hex string
 *   - uuid            — standard UUID v4
 *   - xlmAmount       — positive numeric string
 *   - positiveNumberString    — generic positive number string
 *   - nonNegativeNumberString — generic non-negative number string
 *
 * Schemas:
 *   - donationSchema         — POST /api/donations  body
 *   - verificationSchema     — POST /api/verification-requests body
 *   - leaderboardQuerySchema — GET  /api/leaderboard query
 */
"use strict";

const { z } = require("zod");

// ── Regex constants ──────────────────────────────────────────────────────────
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const TX_HASH_RE = /^[a-fA-F0-9]{64}$/;

// ── Reusable validators ──────────────────────────────────────────────────────

const stellarAddress = z
  .string()
  .regex(STELLAR_ADDRESS_RE, "Invalid Stellar address");

const transactionHash = z
  .string()
  .regex(TX_HASH_RE, "Invalid transaction hash");

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const uuid = z
  .string()
  .regex(UUID_RE, "Invalid UUID");

const xlmAmount = z.string().refine(
  (val) => {
    const n = Number.parseFloat(val);
    return Number.isFinite(n) && n > 0;
  },
  { message: "Amount must be a positive number" },
);

const positiveNumberString = z.string().refine(
  (val) => {
    if (val === "" || val == null) return false;
    const n = Number.parseFloat(val);
    return Number.isFinite(n) && n > 0;
  },
  { message: "Must be a positive number" },
);

const nonNegativeNumberString = z.string().refine(
  (val) => {
    if (val === "" || val == null) return false;
    const n = Number.parseFloat(val);
    return Number.isFinite(n) && n >= 0;
  },
  { message: "Must be a non-negative number" },
);

// ── Shared enums ─────────────────────────────────────────────────────────────

const PROJECT_CATEGORIES = [
  "Reforestation",
  "Solar Energy",
  "Ocean Conservation",
  "Clean Water",
  "Wildlife Protection",
  "Carbon Capture",
  "Wind Energy",
  "Sustainable Agriculture",
  "Other",
];

const DONATION_CURRENCIES = ["XLM", "USDC", "EURT"];

// ── Document schema (used inside verification) ───────────────────────────────

const documentSchema = z.object({
  url: z
    .string()
    .url("document.url must be an http(s) URL")
    .refine(
      (val) => /^https?:\/\//i.test(val),
      "document.url must be an http(s) URL",
    ),
  name: z
    .string()
    .min(1, "document.name must be at least 1 character")
    .max(200, "document.name must be at most 200 characters"),
  size: z.number().int().nonnegative("document.size must be >= 0").optional(),
  contentType: z.string().optional(),
  backend: z.string().optional(),
});

// ── Donation request schema ─────────────────────────────────────────────────

const donationSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  donorAddress: stellarAddress,
  transactionHash,
  amountXLM: xlmAmount,
  currency: z.enum(DONATION_CURRENCIES).optional().default("XLM"),
  message: z.string().max(100, "Message must be at most 100 characters").optional(),
});

// ── Verification request schema ──────────────────────────────────────────────

const verificationSchema = z.object({
  organizationName: z
    .string()
    .min(2, "organizationName must be 2-200 characters")
    .max(200, "organizationName must be 2-200 characters"),
  organizationWebsite: z
    .string()
    .url("organizationWebsite must be a valid http(s) URL")
    .max(500, "organizationWebsite must be a string up to 500 characters")
    .optional()
    .or(z.literal("")),
  organizationCountry: z
    .string()
    .max(80, "organizationCountry must be a string up to 80 characters")
    .optional()
    .or(z.literal("")),
  contactEmail: z.string().email("contactEmail must be a valid email"),
  walletAddress: stellarAddress,
  projectName: z
    .string()
    .min(2, "projectName must be 2-200 characters")
    .max(200, "projectName must be 2-200 characters"),
  projectCategory: z.enum(PROJECT_CATEGORIES, {
    errorMap: () => ({
      message: `projectCategory must be one of: ${PROJECT_CATEGORIES.join(", ")}`,
    }),
  }),
  projectLocation: z
    .string()
    .min(2, "projectLocation must be 2-200 characters")
    .max(200, "projectLocation must be 2-200 characters"),
  projectDescription: z
    .string()
    .max(5000, "projectDescription must be a string up to 5000 characters")
    .optional()
    .or(z.literal("")),
  co2PerXLM: nonNegativeNumberString,
  expectedAnnualTonnesCO2: z
    .union([z.literal(""), nonNegativeNumberString])
    .optional(),
  supportingDocuments: z
    .array(documentSchema)
    .max(20, "supportingDocuments must contain at most 20 entries")
    .optional()
    .default([]),
  notes: z
    .string()
    .max(2000, "notes must be a string up to 2000 characters")
    .optional()
    .or(z.literal("")),
});

// ── Leaderboard query schema ─────────────────────────────────────────────────

const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().positive().optional().default(20),
  period: z.enum(["all", "month", "year"]).optional().default("all"),
  sortBy: z
    .enum(["totalDonatedXLM", "impactScore"])
    .optional()
    .default("totalDonatedXLM"),
  onlyVerified: z.enum(["true", "false"]).optional().default("false"),
  months: z.coerce.number().int().positive().max(24).optional().default(12),
});

module.exports = {
  stellarAddress,
  transactionHash,
  uuid,
  xlmAmount,
  positiveNumberString,
  nonNegativeNumberString,
  donationSchema,
  verificationSchema,
  leaderboardQuerySchema,
  PROJECT_CATEGORIES,
  DONATION_CURRENCIES,
};
