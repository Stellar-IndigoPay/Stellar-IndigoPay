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
const { sanitizedString } = require("./sanitize");

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
    .refine(
      (val) => /^https?:\/\//i.test(val) || /^\/api\/uploads\//i.test(val),
      "document.url must be an http(s) URL or a local /api/uploads URL",
    ),
  name: sanitizedString(200, {
    minLength: 1,
    minMessage: "document.name must be at least 1 character",
    maxMessage: "document.name must be at most 200 characters",
  }),
  size: z.number().int().nonnegative("document.size must be >= 0").optional(),
  contentType: z.string().optional(),
  backend: z.string().optional(),
});

// ── Profile schema ─────────────────────────────────────────────────────────

const profileSchema = z.object({
  displayName: sanitizedString(30, {
    minLength: 2,
    minMessage: "Display name must be between 2 and 30 characters",
    maxMessage: "Display name must be between 2 and 30 characters",
    regex: /^[a-zA-Z0-9_ ]+$/,
    regexMessage: "Only letters, numbers, underscores, and spaces allowed",
    rejectHtml: true,
  })
    .optional()
    .or(z.literal("")),
  bio: sanitizedString(300, {
    maxMessage: "Bio must be at most 300 characters",
  })
    .optional()
    .or(z.literal("")),
});

// ── Project submission schema ───────────────────────────────────────────────

const projectSubmissionSchema = z.object({
  name: sanitizedString(120, {
    minLength: 3,
    minMessage: "name must be between 3 and 120 characters",
    maxMessage: "name must be between 3 and 120 characters",
  }),
  category: z.enum(PROJECT_CATEGORIES, {
    errorMap: () => ({
      message: `category must be one of: ${PROJECT_CATEGORIES.join(", ")}`,
    }),
  }),
  description: sanitizedString(5000, {
    minLength: 10,
    minMessage: "description must be between 10 and 5000 characters",
    maxMessage: "description must be between 10 and 5000 characters",
  }),
  location: sanitizedString(200, {
    minLength: 2,
    minMessage: "location must be between 2 and 200 characters",
    maxMessage: "location must be between 2 and 200 characters",
  }),
  goalXLM: positiveNumberString,
  walletAddress: stellarAddress,
  organization: z.object({
    name: sanitizedString(200, {
      minLength: 1,
      minMessage: "Organization name is required",
    }),
    website: z
      .string()
      .url("Organization website must be a valid URL")
      .optional()
      .or(z.literal("")),
    country: sanitizedString(80).optional(),
    contactEmail: z.string().email("Contact email must be a valid email"),
  }),
  co2Methodology: z.object({
    name: sanitizedString(200, {
      minLength: 1,
      minMessage: "Methodology name is required",
    }),
    verificationBody: sanitizedString(200).optional(),
    annualTonnesCO2: positiveNumberString,
    documentUrl: z
      .string()
      .url("Document URL must be a valid URL")
      .optional()
      .or(z.literal("")),
  }),
  impactMetrics: z
    .array(sanitizedString(200))
    .optional()
    .default([]),
  // Tags are stored as a Postgres TEXT[] and feed full-text search, so both
  // the array length and each entry's length are bounded to prevent database
  // and search-index bloat. `.trim()` runs before the length checks, so
  // whitespace-only tags are rejected as empty.
  tags: z
    .array(
      sanitizedString(50, {
        minLength: 1,
        trim: true,
        truncate: false,
        minMessage: "each tag must be a non-empty string",
        maxMessage: "each tag must be at most 50 characters",
      }),
    )
    .max(10, "tags must contain at most 10 entries")
    .optional()
    .default([]),
});

const campaignSchema = z.object({
  title: sanitizedString(120, {
    minLength: 3,
    trim: true,
    minMessage: "title must be between 3 and 120 characters",
    maxMessage: "title must be between 3 and 120 characters",
  }),
  goalXLM: positiveNumberString,
  deadline: z
    .string()
    .refine((value) => {
      const deadlineDate = new Date(value);
      return !Number.isNaN(deadlineDate.getTime());
    }, "deadline must be a valid ISO date string")
    .refine((value) => {
      const deadlineDate = new Date(value);
      return deadlineDate.getTime() > Date.now();
    }, "deadline must be in the future"),
  description: sanitizedString(500, {
    trim: true,
    maxMessage: "description must be 500 characters or fewer",
  })
    .optional()
    .or(z.literal("")),
});

// ── Donation request schema ─────────────────────────────────────────────────

const donationSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  donorAddress: stellarAddress,
  transactionHash,
  amountXLM: xlmAmount,
  currency: z.enum(DONATION_CURRENCIES).optional().default("XLM"),
  message: sanitizedString(100, {
    maxMessage: "Message must be at most 100 characters",
  }).optional(),
  anonymous: z.boolean().optional().default(false),
});

// ── Verification request schema ──────────────────────────────────────────────

const verificationSchema = z.object({
  organizationName: sanitizedString(200, {
    minLength: 2,
    minMessage: "organizationName must be 2-200 characters",
    maxMessage: "organizationName must be 2-200 characters",
  }),
  organizationWebsite: z
    .string()
    .url("organizationWebsite must be a valid http(s) URL")
    .max(500, "organizationWebsite must be a string up to 500 characters")
    .optional()
    .or(z.literal("")),
  organizationCountry: sanitizedString(80, {
    maxMessage: "organizationCountry must be a string up to 80 characters",
  })
    .optional()
    .or(z.literal("")),
  contactEmail: z.string().email("contactEmail must be a valid email"),
  walletAddress: stellarAddress,
  projectName: sanitizedString(200, {
    minLength: 2,
    minMessage: "projectName must be 2-200 characters",
    maxMessage: "projectName must be 2-200 characters",
  }),
  projectCategory: z.enum(PROJECT_CATEGORIES, {
    errorMap: () => ({
      message: `projectCategory must be one of: ${PROJECT_CATEGORIES.join(", ")}`,
    }),
  }),
  projectLocation: sanitizedString(200, {
    minLength: 2,
    minMessage: "projectLocation must be 2-200 characters",
    maxMessage: "projectLocation must be 2-200 characters",
  }),
  projectDescription: sanitizedString(5000, {
    maxMessage: "projectDescription must be a string up to 5000 characters",
  })
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
  notes: sanitizedString(2000, {
    maxMessage: "notes must be a string up to 2000 characters",
  })
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
  UUID_RE,
  xlmAmount,
  positiveNumberString,
  nonNegativeNumberString,
  donationSchema,
  verificationSchema,
  leaderboardQuerySchema,
  profileSchema,
  projectSubmissionSchema,
  campaignSchema,
  PROJECT_CATEGORIES,
  DONATION_CURRENCIES,
};
