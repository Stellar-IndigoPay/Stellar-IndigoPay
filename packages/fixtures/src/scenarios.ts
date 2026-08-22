/**
 * Scenario builders composing primitive fixtures into realistic
 * multi-object test states for shared use across frontend, mobile,
 * and extension test suites.
 */

import { createRNG } from "./rng";
import {
  project,
  donation,
  match,
  queueItem,
  timeline,
} from "./builders";
import type { Project, Donation, QueueItem, TimelineEntry, DonationMatch } from "./types";

// ── Scenario Types ────────────────────────────────────────────────────

export interface OfflineReplayScenario {
  project: Project;
  cachedDonations: Donation[];
  offlineQueue: QueueItem[];
  /** Items that were queued while offline and should be replayed. */
  pendingItems: QueueItem[];
}

export interface IdempotentRetryScenario {
  project: Project;
  originalDonation: Donation;
  /** The same donation submitted with the same idempotency key. */
  retryDonation: Donation;
  idempotencyKey: string;
}

export interface StalePriceScenario {
  project: Project;
  /** The project's price at the time the donation was initiated. */
  stalePrice: string;
  /** The project's price after the market moved. */
  freshPrice: string;
  /** The donation attempted with the stale price. */
  donation: Donation;
}

export interface ConflictScenario {
  project: Project;
  /** First successful donation. */
  firstDonation: Donation;
  /** Second donation that conflicts (e.g., double-submit). */
  secondDonation: Donation;
  /** The match offer involved in the conflict. */
  match: DonationMatch;
  /** The timeline showing both donations. */
  timeline: TimelineEntry[];
}

// ── Scenario Builders ─────────────────────────────────────────────────

/**
 * Build an offline-replay scenario.
 *
 * Simulates a user who donated while offline: donations are cached locally
 * in a queue and must be replayed in order when connectivity returns.
 *
 * @param opts.seed - Seed for deterministic generation.
 */
export function offlineReplayScenario(opts: { seed?: number } = {}): OfflineReplayScenario {
  const rng = createRNG(opts.seed ?? 1000);
  const p = project({ seed: rng.int(1, 10000) });

  // 3 cached donations (already visible in the UI from cache)
  const cached = [
    donation({ projectId: p.id, seed: rng.int(1, 10000) }),
    donation({ projectId: p.id, seed: rng.int(1, 10000) }),
    donation({ projectId: p.id, seed: rng.int(1, 10000) }),
  ];

  // 2 items queued while offline
  const pending = [
    queueItem({
      type: "donation",
      payload: { amountXLM: "10", projectId: p.id },
      status: "pending",
      seed: rng.int(1, 10000),
    }),
    queueItem({
      type: "follow",
      payload: { projectId: p.id },
      status: "pending",
      seed: rng.int(1, 10000),
    }),
  ];

  return {
    project: p,
    cachedDonations: cached,
    offlineQueue: [...pending],
    pendingItems: pending,
  };
}

/**
 * Build an idempotent-retry scenario.
 *
 * Simulates a donation that was submitted, the response was lost (network
 * timeout), and the client retries with the same Idempotency-Key. The
 * server should return the original donation, not create a duplicate.
 *
 * retryDonation is a shallow clone of originalDonation — the retry
 * carries the exact same payload.
 *
 * @param opts.seed - Seed for deterministic generation.
 */
export function idempotentRetryScenario(opts: { seed?: number } = {}): IdempotentRetryScenario {
  const rng = createRNG(opts.seed ?? 2000);
  const p = project({ seed: rng.int(1, 10000) });
  const idempotencyKey = createRNG(rng.int(1, 10000)).next().toString(36);

  // Original donation
  const original = donation({
    projectId: p.id,
    seed: rng.int(1, 10000),
  });

  // Retry — exact same payload (shallow clone)
  const retry = { ...original };

  return {
    project: p,
    originalDonation: original,
    retryDonation: retry,
    idempotencyKey,
  };
}

/**
 * Build a stale-price scenario.
 *
 * Simulates a user who opened the donation form when the project had one
 * price, but by the time they submit, the price has moved.
 *
 * freshPrice is guaranteed to differ from stalePrice after formatting.
 *
 * @param opts.seed - Seed for deterministic generation.
 */
export function stalePriceScenario(opts: { seed?: number } = {}): StalePriceScenario {
  const rng = createRNG(opts.seed ?? 3000);
  const p = project({ seed: rng.int(1, 10000) });

  const staleRaw = rng.float(50000, 200000);
  const stalePrice = staleRaw.toFixed(7);

  // Guarantee a different price after rounding: apply a fixed -5% shift
  // (the random multiplier approach can collapse to the same value after rounding)
  let freshRaw = staleRaw * 0.95;
  if (freshRaw.toFixed(7) === stalePrice) {
    // nudge further if rounding still produces equality
    freshRaw = staleRaw * 0.90;
  }
  const freshPrice = freshRaw.toFixed(7);

  const d = donation({
    projectId: p.id,
    seed: rng.int(1, 10000),
  });

  return {
    project: p,
    stalePrice,
    freshPrice,
    donation: d,
  };
}

/**
 * Build a conflict scenario.
 *
 * Simulates two donations that were submitted nearly simultaneously and
 * conflict (e.g., same donor, same project, same transaction hash).
 *
 * The timeline includes both conflict donations so that assertions can
 * verify their presence.
 *
 * @param opts.seed - Seed for deterministic generation.
 */
export function conflictScenario(opts: { seed?: number } = {}): ConflictScenario {
  const rng = createRNG(opts.seed ?? 4000);
  const p = project({ seed: rng.int(1, 10000) });

  const first = donation({ projectId: p.id, seed: rng.int(1, 10000) });
  const second = donation({
    projectId: p.id,
    donorAddress: first.donorAddress,
    transactionHash: first.transactionHash,
    seed: rng.int(1, 10000),
  });

  const m = match({
    projectId: p.id,
    seed: rng.int(1, 10000),
  });

  // Build timeline from the two conflict donations so both appear in entries
  const tl = timeline(p.id, 0, {
    projectName: p.name,
    projectCategory: p.category,
    donations: [first, second],
  });

  return {
    project: p,
    firstDonation: first,
    secondDonation: second,
    match: m,
    timeline: tl,
  };
}
