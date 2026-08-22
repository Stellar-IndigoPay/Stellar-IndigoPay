/**
 * OpenAPI schema validation helper for fixture compatibility tests.
 *
 * Uses js-yaml to parse the OpenAPI spec and ajv to validate fixture
 * output against the canonical API schemas. This ensures fixtures cannot
 * drift from the real API contract.
 */

import * as fs from "fs";
import * as path from "path";
import * as yaml from "js-yaml";
import Ajv, { type ValidateFunction, type ErrorObject } from "ajv";

// Path to the OpenAPI spec (relative to the repo root)
const SPEC_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "docs",
  "api",
  "openapi.yaml",
);

// Cache parsed spec and compiled validators
let cachedSpec: Record<string, any> | null = null;
const validatorCache = new Map<string, ValidateFunction>();

/**
 * Load and parse the OpenAPI YAML spec.
 */
export function loadSpec(): Record<string, any> {
  if (cachedSpec) return cachedSpec;
  const raw = fs.readFileSync(SPEC_PATH, "utf-8");
  cachedSpec = yaml.load(raw) as Record<string, any>;
  return cachedSpec;
}

/**
 * Get a named schema from the OpenAPI spec's components/schemas section.
 */
export function getSchema(schemaName: string): Record<string, any> | null {
  const spec = loadSpec();
  return spec?.components?.schemas?.[schemaName] ?? null;
}

/**
 * Get all schema names defined in the spec.
 */
export function getSchemaNames(): string[] {
  const spec = loadSpec();
  return Object.keys(spec?.components?.schemas ?? {});
}

/**
 * Validate an object against a named OpenAPI schema.
 * Returns { valid, errors } without throwing.
 */
export function validateAgainstSchema(
  data: unknown,
  schemaName: string,
): { valid: boolean; errors: ErrorObject[] | null } {
  const schema = getSchema(schemaName);
  if (!schema) {
    return { valid: false, errors: [{ instancePath: "", schemaPath: "", keyword: "type", params: {}, message: `Schema '${schemaName}' not found` }] };
  }

  let validator = validatorCache.get(schemaName);
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    validator = ajv.compile(schema);
    validatorCache.set(schemaName, validator);
  }

  const valid = validator(data) as boolean;
  return {
    valid,
    errors: valid ? null : (validator.errors ?? null),
  };
}

/**
 * Validate an object against an inline schema object (not a named ref).
 */
export function validateAgainstInlineSchema(
  data: unknown,
  schema: Record<string, any>,
): { valid: boolean; errors: ErrorObject[] | null } {
  const ajv = new Ajv({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  const valid = validate(data) as boolean;
  return {
    valid,
    errors: valid ? null : (validate.errors ?? null),
  };
}
