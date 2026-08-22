/**
 * Tests for the scenario builders.
 *
 * Verifies that each scenario produces coherent multi-object state
 * and is deterministic.
 */
import {
  offlineReplayScenario,
  idempotentRetryScenario,
  stalePriceScenario,
  conflictScenario,
} from "../src/index";

// ── offlineReplayScenario ─────────────────────────────────────────────

describe("offlineReplayScenario()", () => {
  test("returns project, cached donations, offline queue, and pending items", () => {
    const s = offlineReplayScenario({ seed: 42 });
    expect(s.project).toBeDefined();
    expect(s.project.id).toBeDefined();
    expect(s.cachedDonations).toBeInstanceOf(Array);
    expect(s.cachedDonations.length).toBeGreaterThan(0);
    expect(s.offlineQueue).toBeInstanceOf(Array);
    expect(s.pendingItems).toBeInstanceOf(Array);
  });

  test("cached donations belong to the same project", () => {
    const s = offlineReplayScenario({ seed: 42 });
    for (const d of s.cachedDonations) {
      expect(d.projectId).toBe(s.project.id);
    }
  });

  test("pending items have status 'pending'", () => {
    const s = offlineReplayScenario({ seed: 42 });
    for (const item of s.pendingItems) {
      expect(item.status).toBe("pending");
    }
  });

  test("deterministic: same seed produces identical scenario", () => {
    const a = offlineReplayScenario({ seed: 99 });
    const b = offlineReplayScenario({ seed: 99 });
    expect(a.project.id).toBe(b.project.id);
    expect(a.cachedDonations).toEqual(b.cachedDonations);
    expect(a.pendingItems).toEqual(b.pendingItems);
  });

  test("different seeds produce different scenarios", () => {
    const a = offlineReplayScenario({ seed: 1 });
    const b = offlineReplayScenario({ seed: 2 });
    expect(a.project.id).not.toBe(b.project.id);
  });
});

// ── idempotentRetryScenario ───────────────────────────────────────────

describe("idempotentRetryScenario()", () => {
  test("returns project, original donation, retry donation, and idempotency key", () => {
    const s = idempotentRetryScenario({ seed: 42 });
    expect(s.project).toBeDefined();
    expect(s.originalDonation).toBeDefined();
    expect(s.retryDonation).toBeDefined();
    expect(s.idempotencyKey).toBeDefined();
  });

  test("retryDonation is an exact clone of originalDonation", () => {
    const s = idempotentRetryScenario({ seed: 42 });
    expect(s.retryDonation).toEqual(s.originalDonation);
  });

  test("original and retry have the same transaction hash", () => {
    const s = idempotentRetryScenario({ seed: 42 });
    expect(s.retryDonation.transactionHash).toBe(s.originalDonation.transactionHash);
  });

  test("original and retry have the same project", () => {
    const s = idempotentRetryScenario({ seed: 42 });
    expect(s.retryDonation.projectId).toBe(s.originalDonation.projectId);
  });

  test("deterministic: same seed produces identical scenario", () => {
    const a = idempotentRetryScenario({ seed: 77 });
    const b = idempotentRetryScenario({ seed: 77 });
    expect(a.originalDonation.id).toBe(b.originalDonation.id);
    expect(a.retryDonation.id).toBe(b.retryDonation.id);
  });
});

// ── stalePriceScenario ────────────────────────────────────────────────

describe("stalePriceScenario()", () => {
  test("returns project, stale price, fresh price, and donation", () => {
    const s = stalePriceScenario({ seed: 42 });
    expect(s.project).toBeDefined();
    expect(parseFloat(s.stalePrice)).toBeGreaterThan(0);
    expect(parseFloat(s.freshPrice)).toBeGreaterThan(0);
    expect(s.donation).toBeDefined();
  });

  test("stale and fresh prices are guaranteed to be different", () => {
    for (let seed = 0; seed < 50; seed++) {
      const s = stalePriceScenario({ seed });
      expect(s.stalePrice).not.toBe(s.freshPrice);
    }
  });

  test("donation belongs to the project", () => {
    const s = stalePriceScenario({ seed: 42 });
    expect(s.donation.projectId).toBe(s.project.id);
  });

  test("deterministic: same seed produces identical scenario", () => {
    const a = stalePriceScenario({ seed: 55 });
    const b = stalePriceScenario({ seed: 55 });
    expect(a.stalePrice).toBe(b.stalePrice);
    expect(a.freshPrice).toBe(b.freshPrice);
  });
});

// ── conflictScenario ──────────────────────────────────────────────────

describe("conflictScenario()", () => {
  test("returns project, two donations, match, and timeline", () => {
    const s = conflictScenario({ seed: 42 });
    expect(s.project).toBeDefined();
    expect(s.firstDonation).toBeDefined();
    expect(s.secondDonation).toBeDefined();
    expect(s.match).toBeDefined();
    expect(s.timeline).toBeInstanceOf(Array);
  });

  test("both donations belong to the same project", () => {
    const s = conflictScenario({ seed: 42 });
    expect(s.firstDonation.projectId).toBe(s.project.id);
    expect(s.secondDonation.projectId).toBe(s.project.id);
  });

  test("conflicting donations share the same donor and transaction hash", () => {
    const s = conflictScenario({ seed: 42 });
    expect(s.secondDonation.donorAddress).toBe(s.firstDonation.donorAddress);
    expect(s.secondDonation.transactionHash).toBe(s.firstDonation.transactionHash);
  });

  test("match belongs to the same project", () => {
    const s = conflictScenario({ seed: 42 });
    expect(s.match.projectId).toBe(s.project.id);
  });

  test("timeline entries belong to the same project", () => {
    const s = conflictScenario({ seed: 42 });
    for (const entry of s.timeline) {
      expect(entry.project.id).toBe(s.project.id);
    }
  });

  test("timeline contains both conflict donations", () => {
    const s = conflictScenario({ seed: 42 });
    const ids = s.timeline.map((e) => e.donation.id);
    expect(ids).toContain(s.firstDonation.id);
    expect(ids).toContain(s.secondDonation.id);
  });

  test("deterministic: same seed produces identical scenario", () => {
    const a = conflictScenario({ seed: 88 });
    const b = conflictScenario({ seed: 88 });
    expect(a.firstDonation.id).toBe(b.firstDonation.id);
    expect(a.secondDonation.id).toBe(b.secondDonation.id);
  });
});
