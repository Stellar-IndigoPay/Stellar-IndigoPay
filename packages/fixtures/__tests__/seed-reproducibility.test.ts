/**
 * Seed-reproducibility test.
 *
 * Verifies that the same seed always produces identical objects,
 * ensuring test determinism across runs and environments.
 */
import {
  project,
  donation,
  match,
  profile,
  campaign,
  milestone,
  update,
  queueItem,
  timeline,
  createRNG,
  offlineReplayScenario,
  idempotentRetryScenario,
  stalePriceScenario,
  conflictScenario,
} from "../src/index";

const SEEDS = [0, 1, 42, 123, 999, 12345, 99999, 2147483647];

// ── RNG determinism ───────────────────────────────────────────────────

describe("createRNG() seed reproducibility", () => {
  test.each(SEEDS)("seed %i produces identical sequence", (seed) => {
    const a = createRNG(seed);
    const b = createRNG(seed);
    const valuesA = Array.from({ length: 100 }, () => a.next());
    const valuesB = Array.from({ length: 100 }, () => b.next());
    expect(valuesA).toEqual(valuesB);
  });

  test("fork() produces independent but deterministic sequences", () => {
    const a = createRNG(42);
    const b = createRNG(42);
    const forkA = a.fork();
    const forkB = b.fork();
    const valuesA = Array.from({ length: 50 }, () => forkA.next());
    const valuesB = Array.from({ length: 50 }, () => forkB.next());
    expect(valuesA).toEqual(valuesB);
  });
});

// ── Builder determinism ───────────────────────────────────────────────

describe("builder seed reproducibility", () => {
  test.each(SEEDS)("project with seed %i is identical across runs", (seed) => {
    const a = project({ seed });
    const b = project({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("donation with seed %i is identical across runs", (seed) => {
    const a = donation({ seed });
    const b = donation({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("match with seed %i is identical across runs", (seed) => {
    const a = match({ seed });
    const b = match({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("profile with seed %i is identical across runs", (seed) => {
    const a = profile({ seed });
    const b = profile({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("campaign with seed %i is identical across runs", (seed) => {
    const a = campaign({ seed });
    const b = campaign({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("milestone with seed %i is identical across runs", (seed) => {
    const a = milestone({ seed });
    const b = milestone({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("update with seed %i is identical across runs", (seed) => {
    const a = update({ seed });
    const b = update({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("queueItem with seed %i is identical across runs", (seed) => {
    const a = queueItem({ seed });
    const b = queueItem({ seed });
    expect(a).toEqual(b);
  });

  test.each(SEEDS)("timeline with seed %i is identical across runs", (seed) => {
    const a = timeline("proj-test", 5, { seed });
    const b = timeline("proj-test", 5, { seed });
    expect(a).toEqual(b);
  });
});

// ── Scenario determinism ──────────────────────────────────────────────

describe("scenario seed reproducibility", () => {
  test.each(SEEDS)("offlineReplay with seed %i is identical across runs", (seed) => {
    const a = offlineReplayScenario({ seed });
    const b = offlineReplayScenario({ seed });
    expect(a.project.id).toBe(b.project.id);
    expect(a.cachedDonations).toEqual(b.cachedDonations);
    expect(a.pendingItems).toEqual(b.pendingItems);
  });

  test.each(SEEDS)("idempotentRetry with seed %i is identical across runs", (seed) => {
    const a = idempotentRetryScenario({ seed });
    const b = idempotentRetryScenario({ seed });
    expect(a.originalDonation).toEqual(b.originalDonation);
    expect(a.retryDonation).toEqual(b.retryDonation);
  });

  test.each(SEEDS)("stalePrice with seed %i is identical across runs", (seed) => {
    const a = stalePriceScenario({ seed });
    const b = stalePriceScenario({ seed });
    expect(a.stalePrice).toBe(b.stalePrice);
    expect(a.freshPrice).toBe(b.freshPrice);
  });

  test.each(SEEDS)("conflict with seed %i is identical across runs", (seed) => {
    const a = conflictScenario({ seed });
    const b = conflictScenario({ seed });
    expect(a.firstDonation).toEqual(b.firstDonation);
    expect(a.secondDonation).toEqual(b.secondDonation);
  });
});
