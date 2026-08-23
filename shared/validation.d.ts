/**
 * shared/validation.d.ts — type declarations for validation.js.
 *
 * validation.js is plain JS (see its header comment for why: it must
 * load unchanged in the browser and in Node without a build step). This
 * file exists solely so TypeScript consumers (frontend/lib/validation/
 * schemas.ts) keep full zod type inference across the require() boundary
 * instead of everything collapsing to `any`.
 */
import type { z } from "zod";

export const RULES: {
  AMOUNT_MIN: string;
  AMOUNT_MAX: string;
  AMOUNT_MAX_DECIMALS: number;
  MESSAGE_MAX_LEN: number;
  DISPLAY_NAME_MIN: number;
  DISPLAY_NAME_MAX: number;
  BIO_MAX: number;
  PROJECT_NAME_MIN: number;
  PROJECT_NAME_MAX: number;
  DESCRIPTION_MIN: number;
  DESCRIPTION_MAX: number;
  LOCATION_MIN: number;
  LOCATION_MAX: number;
  ORG_NAME_MIN: number;
  ORG_NAME_MAX: number;
  NOTES_MAX: number;
  UPLOAD_MAX_BYTES: number;
};

export const NETWORK_ASSETS: Record<string, string[]>;
export const UPLOAD_ALLOWED_MIME: string[];
export const STELLAR_ADDRESS_RE: RegExp;
export const ASSET_CODE_RE: RegExp;
export const TX_HASH_RE: RegExp;
export const UUID_RE: RegExp;
export const DECIMAL_STRING_RE: RegExp;
export const MESSAGES: Record<string, (params: Record<string, unknown>) => string>;

export function isValidDecimalString(value: string): boolean;
export function decimalPlaces(value: string): number;
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1;
export function codePointLength(str: string): number;
export function interpolate(key: string, params?: Record<string, unknown>): string;
export function getAssetCodesForNetwork(network: string): string[];
export function validateUploadMeta(
  meta: { size?: number; mimetype?: string },
  overrides?: { maxBytes?: number },
): { valid: boolean; key?: string; message?: string };

export const stellarAddress: z.ZodType<string>;
export const assetCode: z.ZodType<string>;
export const transactionHash: z.ZodType<string>;
export const uuid: z.ZodType<string>;

export function amountString(opts?: {
  field?: string;
  min?: string;
  max?: string;
  maxDecimals?: number;
}): z.ZodType<string>;

export function nonNegativeAmountString(opts?: { field?: string }): z.ZodType<string>;

export function boundedText(opts: {
  field?: string;
  min?: number;
  max: number;
  required?: boolean;
  trim?: boolean;
  sanitize?: (value: string, maxLength?: number) => string;
  truncate?: boolean;
  regex?: RegExp;
  rejectHtml?: boolean;
}): z.ZodType<string | undefined>

export function emailField(field?: string): z.ZodType<string>;
export function urlField(field?: string): z.ZodType<string>;
export function enumField(values: readonly string[], field?: string): z.ZodType<string>;

export function createDonationSchema(opts?: { network?: string }): z.ZodObject<{
  projectId: z.ZodType<string>;
  donorAddress: z.ZodType<string>;
  transactionHash: z.ZodType<string>;
  amountXLM: z.ZodType<string>;
  currency: z.ZodType<string>;
  message: z.ZodType<string | undefined>;
  anonymous: z.ZodType<boolean>;
}>;

export function createProfileSchema(): z.ZodObject<{
  displayName: z.ZodType<string | undefined>;
  bio: z.ZodType<string | undefined>;
}>;

export function createProjectSubmissionSchema(opts?: {
  network?: string;
  categories?: readonly string[];
}): z.ZodObject<{
  name: z.ZodType<string>;
  category: z.ZodType<string>;
  description: z.ZodType<string>;
  location: z.ZodType<string>;
  goalXLM: z.ZodType<string>;
  walletAddress: z.ZodType<string>;
  organization: z.ZodType<{
    name: string;
    website?: string;
    country?: string;
    contactEmail: string;
  }>;
  co2Methodology: z.ZodType<{
    name: string;
    verificationBody?: string;
    annualTonnesCO2: string;
    documentUrl?: string;
  }>;
  impactMetrics: z.ZodType<string[]>;
  tags: z.ZodType<string[]>;
}>;
