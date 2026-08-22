/**
 * @stellar-indigopay/fixtures/validation
 *
 * OpenAPI schema validation utilities. This module requires Node.js-only
 * modules (fs, path, js-yaml, ajv) and should NOT be imported in
 * React Native or browser environments. Import from the main entry
 * point for builders/scenarios instead.
 */

export {
  loadSpec,
  getSchema,
  getSchemaNames,
  validateAgainstSchema,
  validateAgainstInlineSchema,
} from "./validation";
