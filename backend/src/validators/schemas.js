/**
 * src/validators/schemas.js
 *
 * Zod-based validation schemas and reusable validators for the backend.
 *
 * As of Issue #90-follow-up ("single source of truth for input
 * validation"), the primitives that used to drift from the frontend
 * (address/hash/amount formats, decimal precision, message length,
 * donation/profile/project-registration bounds) now come from
 * `shared/validation.js`, the same module `frontend/lib/validation/
 * schemas.ts` builds on. shared/validation.js's `sanitize` hook is fed
 * this file's `sanitize()` (HTML/bidi-char stripping, NFC normalization —
 * see ./sanitize.js) so the sanitization added alongside Issue #90 stays
 * server-only, in one place, while bounds/format rules stay shared with
 * the frontend. Only backend-only schemas (verification requests,
 * campaigns, leaderboard query, documents) still live entirely here.
 *
 * Reusable validators:
 *   - stellarAddress  — Stellar public key (G…, base-32)
 *   - transactionHash — 64-char hex string
 *   - uuid            — standard UUID v4
 *   - xlmAmount       — bounded donation-amount string (shared RULES)
 *   - positiveNumberString    — generic positive number string
 *   - nonNegativeNumberString — generic non-negative number string
 *
 * Schemas:
 *   - donationSchema          — POST /api/donations  body
 *   - profileSchema           — PATCH /api/profiles/:publicKey body
 *   - projectSubmissionSchema — POST /api/projects (registration) body
 *   - verificationSchema      — POST /api/verification-requests body
 *   - leaderboardQuerySchema  — GET  /api/leaderboard query
 */
"use strict";

const { z } = require("zod");
const shared = require("../../../shared/validation");
const { sanitizedString, sanitize } = require("./sanitize");

const {
  stellarAddress,
  transactionHash,
  uuid,
  UUID_RE,
  amountString,
  nonNegativeAmountString,
  createDonationSchema,
  createProfileSchema,
  createProjectSubmissionSchema,
} = shared;

// The current deployment targets testnet; wiring this to
// process.env.STELLAR_NETWORK keeps mainnet-only asset lists from
// silently taking effect until the env var is actually set.
const NETWORK = process.env.STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

// `xlmAmount` is kept as the historical export name for a bare positive
// amount string (no field name in its message, for callers that don't
// go through a full schema, e.g. ad-hoc route checks).
const xlmAmount = amountString({ field: "Amount" });

const positiveNumberString = amountString({ field: "Value" });
const nonNegativeNumberString = nonNegativeAmountString({ field: "Value" });

// ── Shared enums ─────────────────────────────────────────────────────────

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

// ── Document schema (used inside verification) ─────────────────────────

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

// ── Profile schema ───────────────────────────────────────────────────────
// Sourced from shared/validation.js so the 2–30 char / regex rules can
// never drift from EditProfileForm's client-side copy again (Issue #90).
// `sanitize` wires in this file's HTML/bidi-char stripping server-side.

const profileSchema = createProfileSchema({ sanitize });

// ── Project submission ("registration") schema ─────────────────────────
// Sourced from shared/validation.js; category list, network, and
// sanitize stay backend-specific inputs; bounds/formats are shared.

const projectSubmissionSchema = createProjectSubmissionSchema({
  network: NETWORK,
  categories: PROJECT_CATEGORIES,
  sanitize,
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

// ── Donation request schema ─────────────────────────────────────────────
// Sourced from shared/validation.js — this is the schema that used to
// diverge from DonateForm's frontend copy (min amount, decimal places).
// `sanitize` applies to `message` only, matching main's prior behavior.

const donationSchema = createDonationSchema({ network: NETWORK, sanitize });

// ── Verification request schema ──────────────────────────────────────────

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

// ── Leaderboard query schema ─────────────────────────────────────────────

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