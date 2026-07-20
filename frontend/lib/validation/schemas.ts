import { z } from "zod";
import { PROJECT_CATEGORIES } from "@/utils/format";

// ── Shared enums ─────────────────────────────────────────────────────────────
export const DONATION_CURRENCIES = ["XLM", "USDC", "EURT"] as const;

// ── Reusable validators ──────────────────────────────────────────────────────

export const walletAddressSchema = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, "Invalid Stellar address");

export const stellarTxHashSchema = z
  .string()
  .regex(/^[a-fA-F0-9]{64}$/, "Invalid transaction hash");

export const positiveNumberString = z.string().refine(
  (val) => {
    if (val === "" || val == null) return false;
    const n = Number.parseFloat(val);
    return Number.isFinite(n) && n > 0;
  },
  { message: "Must be a positive number" },
);

export const nonNegativeNumberString = z.string().refine(
  (val) => {
    if (val === "" || val == null) return false;
    const n = Number.parseFloat(val);
    return Number.isFinite(n) && n >= 0;
  },
  { message: "Must be a non-negative number" },
);

// ── Document schema (used inside verification) ───────────────────────────────

export const documentSchema = z.object({
  url: z
    .string()
    .refine(
      (val) => /^https?:\/\//i.test(val) || /^\/api\/uploads\//i.test(val),
      "document.url must be an http(s) URL or a local /api/uploads URL",
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

export const donationSchema = z.object({
  projectId: z.string().min(1, "Project ID is required"),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,7})?$/)
    .refine(
      (val) => {
        const n = Number.parseFloat(val);
        return Number.isFinite(n) && n >= 1;
      },
      { message: "Minimum donation is 1" }
    ),
  message: z.string().max(100, "Message must be at most 100 characters").optional(),
});

// ── Verification request schema ──────────────────────────────────────────────

export const verificationRequestSchema = z.object({
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
  walletAddress: walletAddressSchema,
  projectName: z
    .string()
    .min(2, "projectName must be 2-200 characters")
    .max(200, "projectName must be 2-200 characters"),
  projectCategory: z.enum(PROJECT_CATEGORIES as [string, ...string[]], {
    message: `projectCategory must be one of: ${PROJECT_CATEGORIES.join(", ")}`,
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

// ── Profile schema ─────────────────────────────────────────────────────────

export const profileSchema = z.object({
  displayName: z
    .string()
    .min(2, "Display name must be between 2 and 30 characters")
    .max(30, "Display name must be between 2 and 30 characters")
    .regex(/^[a-zA-Z0-9_ ]+$/, "Only letters, numbers, underscores, and spaces allowed")
    .optional()
    .or(z.literal("")),
  bio: z
    .string()
    .max(300, "Bio must be at most 300 characters")
    .optional()
    .or(z.literal("")),
});

// ── Project submission schema ───────────────────────────────────────────────

export const projectSubmissionSchema = z.object({
  name: z
    .string()
    .min(3, "name must be between 3 and 120 characters")
    .max(120, "name must be between 3 and 120 characters"),
  category: z.enum(PROJECT_CATEGORIES as [string, ...string[]], {
    message: `category must be one of: ${PROJECT_CATEGORIES.join(", ")}`,
  }),
  description: z
    .string()
    .min(10, "description must be between 10 and 5000 characters")
    .max(5000, "description must be between 10 and 5000 characters"),
  location: z
    .string()
    .min(2, "location must be between 2 and 200 characters")
    .max(200, "location must be between 2 and 200 characters"),
  goalXLM: positiveNumberString,
  walletAddress: walletAddressSchema,
  organization: z.object({
    name: z.string().min(1, "Organization name is required"),
    website: z
      .string()
      .url("Organization website must be a valid URL")
      .optional()
      .or(z.literal("")),
    country: z.string().optional(),
    contactEmail: z.string().email("Contact email must be a valid email"),
  }),
  co2Methodology: z.object({
    name: z.string().min(1, "Methodology name is required"),
    verificationBody: z.string().optional(),
    annualTonnesCO2: positiveNumberString,
    documentUrl: z
      .string()
      .url("Document URL must be a valid URL")
      .optional()
      .or(z.literal("")),
  }),
  impactMetrics: z.array(z.string()).optional().default([]),
});
