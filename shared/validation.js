/**
 * shared/validation.js — Issue #90 follow-up: single source of truth for
 * input validation (GF-XXX "shared validation schema").
 *
 * Both `backend/src/validators/schemas.js` and `frontend/lib/validation/
 * schemas.ts` build their zod schemas from the primitives and RULES
 * exported here, so amount bounds, decimal precision, message length,
 * and address/format checks can no longer drift between client and
 * server. Change a rule once, in RULES below, and both sides pick it up.
 *
 * Pure, dependency-light, and framework-agnostic: only `zod` is used
 * (already a dependency of both `frontend` and `backend`), no Node-only
 * APIs (no `fs`, `Buffer`, `crypto`, ...), so this file loads unchanged
 * in the browser and in Node/Jest.
 */
"use strict";

const { z } = require("zod");

// ── Format constants ─────────────────────────────────────────────────────
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/;
const TX_HASH_RE = /^[a-fA-F0-9]{64}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Plain, unsigned decimal string: "123", "0.5", "10000000.1234567".
const DECIMAL_STRING_RE = /^\d{1,18}(\.\d{1,18})?$/;
// Hard ceiling on raw input length before any regex/parsing runs, so a
// malicious multi-KB string can't be thrown at a regex or BigInt() call.
const MAX_RAW_INPUT_LENGTH = 4000;

// ── RULES — the one place bounds live ────────────────────────────────────
const RULES = Object.freeze({
  AMOUNT_MIN: "1",
  AMOUNT_MAX: "10000000",
  AMOUNT_MAX_DECIMALS: 7,
  MESSAGE_MAX_LEN: 100,
  DISPLAY_NAME_MIN: 2,
  DISPLAY_NAME_MAX: 30,
  BIO_MAX: 300,
  PROJECT_NAME_MIN: 3,
  PROJECT_NAME_MAX: 120,
  DESCRIPTION_MIN: 10,
  DESCRIPTION_MAX: 5000,
  LOCATION_MIN: 2,
  LOCATION_MAX: 200,
  ORG_NAME_MIN: 2,
  ORG_NAME_MAX: 200,
  NOTES_MAX: 2000,
  UPLOAD_MAX_BYTES: 10 * 1024 * 1024,
});

// Networks are parameterized rather than hard-coded so testnet-only
// assets (e.g. EURT) don't silently validate on mainnet or vice versa.
const NETWORK_ASSETS = Object.freeze({
  testnet: ["XLM", "USDC", "EURT"],
  mainnet: ["XLM", "USDC"],
});

const UPLOAD_ALLOWED_MIME = Object.freeze([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/plain",
  "text/csv",
  "application/zip",
]);

function getAssetCodesForNetwork(network) {
  return NETWORK_ASSETS[network] || NETWORK_ASSETS.testnet;
}

// ── Decimal-string helpers (BigInt-based — never Number.parseFloat) ─────
// Float parsing loses precision on 7-decimal Stellar amounts (e.g.
// 0.1 + 0.2 !== 0.3), so every bound check below works on the decimal
// string itself and only converts to BigInt after zero-padding.

function isValidDecimalString(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_RAW_INPUT_LENGTH &&
    DECIMAL_STRING_RE.test(value)
  );
}

function decimalPlaces(value) {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

function toScaledBigInt(value, scale) {
  const [intPart, decPart = ""] = value.split(".");
  const padded = (decPart + "0".repeat(scale)).slice(0, scale);
  return BigInt(intPart + padded);
}

/** Returns -1, 0, or 1, comparing two decimal strings exactly. */
function compareDecimalStrings(a, b) {
  const scale = Math.max(decimalPlaces(a), decimalPlaces(b));
  const av = toScaledBigInt(a, scale);
  const bv = toScaledBigInt(b, scale);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

// Unicode-safe length: counts code points (what a person perceives as
// "characters"), not UTF-16 code units, so a message full of emoji or
// astral-plane characters isn't undercounted relative to the server.
function codePointLength(str) {
  return Array.from(str).length;
}

// ── Message catalog (English canon; mirrored into frontend/locales/*.json
// under the "validation" namespace so backend and UI text never diverge).
// Each entry is looked up by `key` and interpolated the same way the
// frontend's `t()` does ({{param}}), so backend error text and the i18n
// catalog stay word-for-word identical.
const MESSAGES = {
  "wallet.invalid": () => "Invalid Stellar address",
  "assetCode.invalid": () => "Invalid asset code",
  "txHash.invalid": () => "Invalid transaction hash",
  "amount.invalidFormat": (p) => `${p.field} must be a valid decimal number`,
  "amount.tooSmall": (p) => `${p.field} must be at least ${p.min}`,
  "amount.tooLarge": (p) => `${p.field} must be at most ${p.max}`,
  "amount.precision": (p) =>
    `${p.field} must have at most ${p.max} decimal places`,
  "length.between": (p) =>
    `${p.field} must be between ${p.min} and ${p.max} characters`,
  "length.max": (p) => `${p.field} must be at most ${p.max} characters`,
  "format.html": (p) => `${p.field} cannot contain HTML tags`,
  "format.pattern": (p) => `${p.field} format is invalid`,
  "list.max": (p) => `${p.field} must contain at most ${p.max} entries`,
  "format.invalid": (p) => p.detail,
  "number.positive": (p) => `${p.field} must be a positive number`,
  "number.nonNegative": (p) => `${p.field} must be a non-negative number`,
  "enum.invalid": (p) => `${p.field} must be one of: ${p.options}`,
  "email.invalid": (p) => `${p.field} must be a valid email`,
  "url.invalid": (p) => `${p.field} must be a valid URL`,
  "required": (p) => `${p.field} is required`,
  "upload.tooLarge": (p) => `File exceeds the maximum size of ${p.maxMB}MB`,
  "upload.invalidType": (p) => `File type must be one of: ${p.types}`,
};

function interpolate(key, params) {
  const fn = MESSAGES[key];
  return fn ? fn(params || {}) : key;
}

/** Attaches a zod custom issue whose `params.key` maps into MESSAGES. */
function addIssue(ctx, key, params) {
  ctx.addIssue({
    code: "custom",
    message: interpolate(key, params),
    params: { key, ...params },
  });
}

// ── Reusable field validators ────────────────────────────────────────────

const stellarAddress = z
  .string()
  .max(MAX_RAW_INPUT_LENGTH)
  .superRefine((val, ctx) => {
    if (!STELLAR_ADDRESS_RE.test(val)) addIssue(ctx, "wallet.invalid");
  });

const assetCode = z
  .string()
  .max(MAX_RAW_INPUT_LENGTH)
  .superRefine((val, ctx) => {
    if (!ASSET_CODE_RE.test(val)) addIssue(ctx, "assetCode.invalid");
  });

const transactionHash = z
  .string()
  .max(MAX_RAW_INPUT_LENGTH)
  .superRefine((val, ctx) => {
    if (!TX_HASH_RE.test(val)) addIssue(ctx, "txHash.invalid");
  });

const uuid = z
  .string()
  .max(MAX_RAW_INPUT_LENGTH)
  .regex(UUID_RE, interpolate("format.invalid", { detail: "Invalid UUID" }));

/**
 * A bounded decimal-amount string, e.g. "12.5000000". `field` names the
 * value in error messages; `min`/`max`/`maxDecimals` default to RULES so
 * every call site shares the same bounds unless explicitly overridden.
 */
function amountString({
  field = "Amount",
  min = RULES.AMOUNT_MIN,
  max = RULES.AMOUNT_MAX,
  maxDecimals = RULES.AMOUNT_MAX_DECIMALS,
} = {}) {
  return z
    .string()
    .max(MAX_RAW_INPUT_LENGTH)
    .superRefine((val, ctx) => {
      if (!isValidDecimalString(val)) {
        return addIssue(ctx, "amount.invalidFormat", { field });
      }
      if (decimalPlaces(val) > maxDecimals) {
        return addIssue(ctx, "amount.precision", { field, max: maxDecimals });
      }
      if (compareDecimalStrings(val, min) < 0) {
        return addIssue(ctx, "amount.tooSmall", { field, min });
      }
      if (compareDecimalStrings(val, max) > 0) {
        return addIssue(ctx, "amount.tooLarge", { field, max });
      }
    });
}

/** A non-negative decimal-amount string (e.g. CO2/XLM rate: 0 is valid). */
function nonNegativeAmountString({ field = "Value" } = {}) {
  return amountString({ field, min: "0" });
}

/** Free text bounded by Unicode code points, with an optional min. */
function boundedText({
  field = "Text",
  min = 0,
  max,
  required = false,
  trim = false,
  sanitize,     // optional (value, maxLength?) => string, e.g. backend's sanitize.js
  truncate = true,  // when `sanitize` is given: truncate at max vs reject over-max
  regex,
  rejectHtml = false,
} = {}) {
  let base = z.string().max(MAX_RAW_INPUT_LENGTH);

  if (rejectHtml) {
    base = base.superRefine((val, ctx) => {
      if (/<[^>]*>/.test(val)) addIssue(ctx, "format.html", { field });
    });
  }

  const lengthCheck = (val, ctx) => {
    const len = codePointLength(val);
    if (len > max) return addIssue(ctx, "length.max", { field, max });
    if (min > 0 && len < min) addIssue(ctx, "length.between", { field, min, max });
    if (regex && !regex.test(val)) addIssue(ctx, "format.pattern", { field });
  };

  let schema;
  if (sanitize) {
    // Zod v4's .transform() returns a ZodPipe, which doesn't expose
    // .trim()/.min()/.max(), so length/trim checks run on the sanitized
    // output via a piped inner schema (mirrors backend/sanitize.js).
    let inner = z.string();
    if (trim) inner = inner.trim();
    inner = inner.superRefine(lengthCheck);
    const maxLenArg = truncate ? max : undefined;
    schema = base.transform((val) => sanitize(val, maxLenArg)).pipe(inner);
  } else {
    schema = trim ? base.trim() : base;
    schema = schema.superRefine(lengthCheck);
  }

  return required ? schema : schema.optional().or(z.literal(""));
}
function emailField(field = "Email") {
  return z
    .string()
    .max(MAX_RAW_INPUT_LENGTH)
    .email(interpolate("email.invalid", { field }));
}

function urlField(field = "URL") {
  return z
    .string()
    .max(MAX_RAW_INPUT_LENGTH)
    .url(interpolate("url.invalid", { field }));
}

function enumField(values, field = "Value") {
  return z.enum(values, {
    message: interpolate("enum.invalid", { field, options: values.join(", ") }),
  });
}

// ── Pure upload metadata check (no Node/browser file APIs involved) ─────
function validateUploadMeta({ size, mimetype }, { maxBytes = RULES.UPLOAD_MAX_BYTES } = {}) {
  if (typeof size === "number" && size > maxBytes) {
    return {
      valid: false,
      key: "upload.tooLarge",
      message: interpolate("upload.tooLarge", {
        maxMB: maxBytes / (1024 * 1024),
      }),
    };
  }
  if (mimetype && !UPLOAD_ALLOWED_MIME.includes(mimetype)) {
    return {
      valid: false,
      key: "upload.invalidType",
      message: interpolate("upload.invalidType", {
        types: UPLOAD_ALLOWED_MIME.join(", "),
      }),
    };
  }
  return { valid: true };
}

// ── Schema factories (parameterized by network) ──────────────────────────

function createDonationSchema({ network = "testnet", sanitize } = {}) {
  const currencies = getAssetCodesForNetwork(network);
  return z.object({
    projectId: boundedText({ field: "Project ID", max: 200, required: true }),
    donorAddress: stellarAddress,
    transactionHash,
    amountXLM: amountString({ field: "Amount" }),
    currency: enumField(currencies, "Currency").optional().default("XLM"),
    message: boundedText({ field: "Message", max: RULES.MESSAGE_MAX_LEN, sanitize }),
    anonymous: z.boolean().optional().default(false),
  });
}

function createProfileSchema({ sanitize } = {}) {
  return z.object({
    displayName: boundedText({
      field: "Display name",
      min: RULES.DISPLAY_NAME_MIN,
      max: RULES.DISPLAY_NAME_MAX,
      regex: /^[a-zA-Z0-9_ ]+$/,
      rejectHtml: true,
      sanitize,
    }),
    bio: boundedText({ field: "Bio", max: RULES.BIO_MAX, sanitize }),
  });
}

function createProjectSubmissionSchema({ network = "testnet", categories, sanitize } = {}) {
  return z.object({
    name: boundedText({
      field: "Name", min: RULES.PROJECT_NAME_MIN, max: RULES.PROJECT_NAME_MAX,
      required: true, sanitize,
    }),
    category: enumField(categories, "Category"),
    description: boundedText({
      field: "Description", min: RULES.DESCRIPTION_MIN, max: RULES.DESCRIPTION_MAX,
      required: true, sanitize,
    }),
    location: boundedText({
      field: "Location", min: RULES.LOCATION_MIN, max: RULES.LOCATION_MAX,
      required: true, sanitize,
    }),
    goalXLM: amountString({ field: "Goal", max: RULES.AMOUNT_MAX }),
    walletAddress: stellarAddress,
    organization: z.object({
      name: boundedText({ field: "Organization name", min: 1, max: 200, required: true, sanitize }),
      website: urlField("Organization website").optional().or(z.literal("")),
      country: z.string().max(MAX_RAW_INPUT_LENGTH).optional(),
      contactEmail: emailField("Contact email"),
    }),
    co2Methodology: z.object({
      name: boundedText({ field: "Methodology name", min: 1, max: 200, required: true, sanitize }),
      verificationBody: z.string().max(MAX_RAW_INPUT_LENGTH).optional(),
      annualTonnesCO2: amountString({ field: "Annual tonnes CO2" }),
      documentUrl: urlField("Document URL").optional().or(z.literal("")),
    }),
    impactMetrics: z
      .array(boundedText({ field: "Impact metric", max: 200, required: true, sanitize }))
      .optional()
      .default([]),
    tags: z
      .array(boundedText({
        field: "Tag", min: 1, max: 50, required: true, trim: true,
        sanitize, truncate: false,
      }))
      .max(10, interpolate("list.max", { field: "Tags", max: 10 }))
      .optional()
      .default([]),
  });
}

module.exports = {
  // constants
  RULES,
  NETWORK_ASSETS,
  UPLOAD_ALLOWED_MIME,
  STELLAR_ADDRESS_RE,
  ASSET_CODE_RE,
  TX_HASH_RE,
  UUID_RE,
  DECIMAL_STRING_RE,
  MESSAGES,
  // helpers
  isValidDecimalString,
  decimalPlaces,
  compareDecimalStrings,
  codePointLength,
  interpolate,
  getAssetCodesForNetwork,
  validateUploadMeta,
  // field validators
  stellarAddress,
  assetCode,
  transactionHash,
  uuid,
  amountString,
  nonNegativeAmountString,
  boundedText,
  emailField,
  urlField,
  enumField,
  // schema factories
  createDonationSchema,
  createProfileSchema,
  createProjectSubmissionSchema,
};
