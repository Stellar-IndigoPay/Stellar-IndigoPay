import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";
import { PROJECT_CATEGORIES } from "@/utils/format";

// ── Reusable field-level validators ────────────────────────────────────────────

/**
 * Stellar public key validator using checksum validation from stellar-sdk.
 * Accepts only valid Ed25519 public keys (G-address format, 56 chars).
 */
export const stellarAddress = z
  .string()
  .trim()
  .min(1, "Stellar wallet address is required")
  .refine((val) => StrKey.isValidEd25519PublicKey(val), {
    message:
      "Invalid Stellar public key. Must start with G and be 56 characters.",
  });

/**
 * XLM amount validator: positive decimal with up to 7 decimal places.
 */
export const xlmAmount = z
  .string()
  .regex(/^\d+(\.\d{1,7})?$/, {
    message: "Must be a valid XLM amount (up to 7 decimal places)",
  })
  .refine((val) => parseFloat(val) > 0, {
    message: "Amount must be greater than 0",
  });

/**
 * Positive whole number string validator (for annual tonnes CO2).
 */
export const wholeNumberString = z
  .string()
  .regex(/^\d+$/, "Must be a whole number");

// ── Project submission schema ─────────────────────────────────────────────────

export const submitProjectSchema = z.object({
  name: z
    .string()
    .min(3, "Project name must be at least 3 characters")
    .max(120, "Project name must be at most 120 characters"),
  category: z
    .string()
    .refine((val) => PROJECT_CATEGORIES.includes(val as any), {
      message: "Please select a valid category",
    }),
  description: z
    .string()
    .min(50, "Description must be at least 50 characters")
    .max(5000, "Description must be at most 5000 characters"),
  location: z.string().min(2, "Location is required"),
  goalXLM: xlmAmount,
  walletAddress: stellarAddress,
  organization: z.object({
    name: z.string().min(2, "Organization name is required"),
    website: z.string().url("Must be a valid URL").or(z.literal("")),
    country: z.string().min(2, "Country is required"),
    contactEmail: z.string().email("Invalid email address").min(1, "Contact email is required"),
  }),
  co2Methodology: z.object({
    name: z.string().min(2, "Methodology name is required"),
    verificationBody: z.string().min(2, "Verification body is required"),
    annualTonnesCO2: wholeNumberString.refine(
      (val) => parseInt(val, 10) > 0,
      { message: "Must be greater than 0" },
    ),
    documentUrl: z.string().url("Must be a valid URL").or(z.literal("")),
  }),
  impactMetrics: z.array(z.string()),
});

export type SubmitProjectFormData = z.infer<typeof submitProjectSchema>;

// ── Verification request schema (apply.tsx) ───────────────────────────────────

export const verificationRequestSchema = z.object({
  organizationName: z.string().min(2, "Organization name is required"),
  organizationWebsite: z
    .string()
    .url("Must be a valid URL")
    .or(z.literal(""))
    .optional(),
  organizationCountry: z.string().optional(),
  contactEmail: z
    .string()
    .email("Invalid email address")
    .min(1, "Contact email is required"),
  walletAddress: stellarAddress,
  projectName: z
    .string()
    .min(3, "Project name must be at least 3 characters")
    .max(120, "Project name must be at most 120 characters"),
  projectCategory: z
    .string()
    .refine((val) => PROJECT_CATEGORIES.includes(val as any), {
      message: "Please select a valid category",
    }),
  projectLocation: z.string().min(2, "Location is required"),
  projectDescription: z.string().optional(),
  co2PerXLM: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Must be a valid decimal number")
    .refine((val) => parseFloat(val) >= 0, {
      message: "Must be a non-negative number",
    }),
  expectedAnnualTonnesCO2: z
    .string()
    .regex(/^\d+(\.\d+)?$/, "Must be a valid number")
    .refine((val) => parseFloat(val) >= 0, {
      message: "Must be a non-negative number",
    })
    .optional()
    .or(z.literal("")),
  notes: z.string().optional(),
});

export type VerificationRequestFormData = z.infer<
  typeof verificationRequestSchema
>;
