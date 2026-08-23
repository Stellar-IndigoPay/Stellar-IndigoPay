import { z } from "zod";
import { PROJECT_CATEGORIES } from "@/utils/format";
// Single source of truth for validation rules (Issue #90-follow-up).
// Every bound, format regex, and error-message key below comes from
// `shared/validation.js` — the same module the backend's
// `src/validators/schemas.js` builds on — so client and server can no
// longer silently drift (amount bounds, decimal precision, message
// length, wallet/tx-hash formats, ...). Typed via validation.d.ts.
import * as shared from "@shared/validation";

const {
  stellarAddress: sharedWalletSchema,
  transactionHash: sharedTxHashSchema,
  amountString,
  nonNegativeAmountString,
  boundedText,
  emailField,
  urlField,
  enumField,
  createDonationSchema,
  createProfileSchema,
  createProjectSubmissionSchema,
  RULES,
} = shared;

// The frontend always talks to whichever network NEXT_PUBLIC_STELLAR_NETWORK
// points at, so its asset list (e.g. testnet-only EURT) matches the backend
// it's actually calling rather than being hard-coded.
const NETWORK =
  process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet" ? "mainnet" : "testnet";

// ── Shared enums ─────────────────────────────────────────────────────────────
export const DONATION_CURRENCIES = ["XLM", "USDC", "EURT"] as const;

// ── Reusable validators ──────────────────────────────────────────────────────

export const walletAddressSchema: z.ZodTypeAny = sharedWalletSchema;
export const stellarTxHashSchema: z.ZodTypeAny = sharedTxHashSchema;
export const positiveNumberString: z.ZodTypeAny = amountString({ field: "Value" });
export const nonNegativeNumberString: z.ZodTypeAny = nonNegativeAmountString({
  field: "Value",
});

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
// This is the exact schema that used to diverge from the backend's
// donationSchema (min amount, decimal precision). DonateForm only
// collects amount/message/projectId client-side (address, tx hash, and
// currency are filled in after wallet signing), so this stays a subset
// of the backend's full createDonationSchema, built from the same
// amountString/boundedText primitives.
export const donationSchema = z.object({
  projectId: boundedText({ field: "Project ID", max: 200, required: true }),
  amount: amountString({ field: "Amount" }),
  message: boundedText({ field: "Message", max: RULES.MESSAGE_MAX_LEN }),
});

/** Full donation payload schema (address, tx hash, currency, amount). */
export const fullDonationSchema = createDonationSchema({ network: NETWORK });

// ── Verification request schema ──────────────────────────────────────────────

export const verificationRequestSchema = z.object({
  organizationName: boundedText({
    field: "Organization name",
    min: 2,
    max: 200,
    required: true,
  }),
  organizationWebsite: urlField("Organization website").optional().or(z.literal("")),
  organizationCountry: boundedText({ field: "Organization country", max: 80 }),
  contactEmail: emailField("Contact email"),
  walletAddress: walletAddressSchema,
  projectName: boundedText({ field: "Project name", min: 2, max: 200, required: true }),
  projectCategory: enumField(PROJECT_CATEGORIES, "Project category"),
  projectLocation: boundedText({
    field: "Project location",
    min: 2,
    max: 200,
    required: true,
  }),
  projectDescription: boundedText({ field: "Project description", max: 5000 }),
  co2PerXLM: nonNegativeNumberString,
  expectedAnnualTonnesCO2: z
    .union([z.literal(""), nonNegativeNumberString])
    .optional(),
  supportingDocuments: z
    .array(documentSchema)
    .max(20, "supportingDocuments must contain at most 20 entries")
    .optional()
    .default([]),
  notes: boundedText({ field: "Notes", max: 2000 }),
});

// ── Profile schema ─────────────────────────────────────────────────────────

export const profileSchema = createProfileSchema();

// ── Project submission ("registration") schema ───────────────────────────

export const projectSubmissionSchema = createProjectSubmissionSchema({
  network: NETWORK,
  categories: PROJECT_CATEGORIES,
});

// ── Inferred form data types ──────────────────────────────────────────────────

export type VerificationRequestFormData = z.infer<
  typeof verificationRequestSchema
>;
export type SubmitProjectFormData = z.infer<typeof projectSubmissionSchema>;
