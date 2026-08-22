/**
 * @stellar-indigopay/fixtures
 *
 * Shared deterministic fixture factory for the Stellar-IndigoPay frontend,
 * mobile, and extension test suites.
 *
 * @example
 * ```ts
 * import { project, donation, offlineReplayScenario } from "@stellar-indigopay/fixtures";
 *
 * const p = project({ name: "My Project" });
 * const d = donation({ projectId: p.id, amountXLM: "10" });
 * const scenario = offlineReplayScenario({ seed: 42 });
 * ```
 */

// ── Builders ──────────────────────────────────────────────────────────
export {
  project,
  donation,
  match,
  profile,
  campaign,
  milestone,
  update,
  queueItem,
  apiResponse,
  paginatedResponse,
  timeline,
} from "./builders";

// ── Scenario Builders ─────────────────────────────────────────────────
export {
  offlineReplayScenario,
  idempotentRetryScenario,
  stalePriceScenario,
  conflictScenario,
} from "./scenarios";

export type {
  OfflineReplayScenario,
  IdempotentRetryScenario,
  StalePriceScenario,
  ConflictScenario,
} from "./scenarios";

// ── Types ─────────────────────────────────────────────────────────────
export type {
  Project,
  Donation,
  DonationMatch,
  Profile,
  Campaign,
  Milestone,
  ProjectUpdate,
  QueueItem,
  TimelineEntry,
  ApiResponseSuccess,
  ApiResponseError,
  PaginatedResponse,
  FixtureOptions,
} from "./types";

// ── RNG ───────────────────────────────────────────────────────────────
export { createRNG } from "./rng";
export type { SeededRNG } from "./rng";

// ── Validation (Node.js only — import from @stellar-indigopay/fixtures/validation-entry)
// Validation exports require fs, path, js-yaml, ajv.
// They are NOT re-exported from the main entry to keep the package
// usable in React Native and browser environments.
// Use: import { ... } from "@stellar-indigopay/fixtures/validation-entry"
