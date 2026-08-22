/**
 * Tests for the shared fixture builders.
 *
 * Verifies that each builder produces valid, deterministic output
 * and respects overrides.
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
  apiResponse,
  paginatedResponse,
  timeline,
} from "../src/index";
import type { Project, Donation, DonationMatch } from "../src/types";
import { createRNG } from "../src/rng";

// ── project() ─────────────────────────────────────────────────────────

describe("project()", () => {
  test("returns a valid Project with all required fields", () => {
    const p = project();
    expect(p.id).toBeDefined();
    expect(p.name).toBeDefined();
    expect(p.description).toBeDefined();
    expect(p.category).toBeDefined();
    expect(p.location).toBeDefined();
    expect(p.walletAddress).toMatch(/^G[A-Z2-7]{55}$/);
    expect(p.goalXLM).toBeDefined();
    expect(p.raisedXLM).toBeDefined();
    expect(p.donorCount).toBeGreaterThanOrEqual(0);
    expect(p.co2OffsetKg).toBeGreaterThanOrEqual(0);
    expect(["active", "completed", "paused", "rejected"]).toContain(p.status);
    expect(typeof p.verified).toBe("boolean");
    expect(typeof p.onChainVerified).toBe("boolean");
    expect(Array.isArray(p.tags)).toBe(true);
    expect(p.createdAt).toBeDefined();
    expect(p.updatedAt).toBeDefined();
  });

  test("deterministic: same seed produces identical output", () => {
    const a = project({ id: "fixed-id" });
    const b = project({ id: "fixed-id" });
    expect(a).toEqual(b);
  });

  test("overrides are applied", () => {
    const p = project({ name: "Custom Project", status: "completed" });
    expect(p.name).toBe("Custom Project");
    expect(p.status).toBe("completed");
  });

  test("wallet address is always a valid Stellar key format", () => {
    for (let i = 0; i < 20; i++) {
      const p = project({ seed: i });
      expect(p.walletAddress).toMatch(/^G[A-Z2-7]{55}$/);
    }
  });

  test("updatedAt is never before createdAt", () => {
    for (let i = 0; i < 20; i++) {
      const p = project({ seed: i });
      expect(new Date(p.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(p.createdAt).getTime(),
      );
    }
  });

  test("raisedXLM never exceeds goalXLM even with overrides", () => {
    const p = project({ raisedXLM: "50000", goalXLM: "10000" });
    expect(parseFloat(p.goalXLM)).toBeGreaterThanOrEqual(parseFloat(p.raisedXLM));
  });
});

// ── donation() ────────────────────────────────────────────────────────

describe("donation()", () => {
  test("returns a valid Donation with all required fields", () => {
    const d = donation();
    expect(d.id).toBeDefined();
    expect(d.projectId).toBeDefined();
    expect(d.amount).toBeDefined();
    expect(d.currency).toBe("XLM");
    expect(d.transactionHash).toMatch(/^[a-f0-9]{64}$/);
    expect(d.createdAt).toBeDefined();
    expect(typeof d.anonymous).toBe("boolean");
  });

  test("deterministic: same seed produces identical output", () => {
    const a = donation({ id: "donation-1" });
    const b = donation({ id: "donation-1" });
    expect(a).toEqual(b);
  });

  test("overrides are applied", () => {
    const d = donation({ amountXLM: "42.5", currency: "XLM", anonymous: true });
    expect(d.amountXLM).toBe("42.5");
    expect(d.anonymous).toBe(true);
  });

  test("projectId links to a project", () => {
    const p = project({ id: "proj-123" });
    const d = donation({ projectId: p.id });
    expect(d.projectId).toBe("proj-123");
  });
});

// ── match() ───────────────────────────────────────────────────────────

describe("match()", () => {
  test("returns a valid DonationMatch with all required fields", () => {
    const m = match();
    expect(m.id).toBeDefined();
    expect(m.projectId).toBeDefined();
    expect(m.matcherAddress).toMatch(/^G[A-Z2-7]{55}$/);
    expect(m.capXLM).toBeDefined();
    expect(m.multiplier).toBeGreaterThanOrEqual(1);
    expect(m.matchedXLM).toBeDefined();
    expect(m.remainingXLM).toBeDefined();
    expect(m.expiresAt).toBeDefined();
    expect(m.createdAt).toBeDefined();
  });

  test("deterministic: same seed produces identical output", () => {
    const a = match({ id: "match-1" });
    const b = match({ id: "match-1" });
    expect(a).toEqual(b);
  });

  test("remainingXLM = capXLM - matchedXLM (approximately)", () => {
    const m = match();
    const cap = parseFloat(m.capXLM);
    const matched = parseFloat(m.matchedXLM);
    const remaining = parseFloat(m.remainingXLM);
    expect(remaining).toBeCloseTo(cap - matched, 2);
  });

  test("remainingXLM recomputes when capXLM/matchedXLM are overridden", () => {
    const m = match({ capXLM: "100", matchedXLM: "30" });
    expect(parseFloat(m.remainingXLM)).toBeCloseTo(70, 2);
  });
});

// ── profile() ─────────────────────────────────────────────────────────

describe("profile()", () => {
  test("returns a valid Profile with all required fields", () => {
    const p = profile();
    expect(p.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    expect(p.totalDonatedXLM).toBeDefined();
    expect(p.projectsSupported).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(p.badges)).toBe(true);
    expect(p.createdAt).toBeDefined();
    expect(p.updatedAt).toBeDefined();
  });

  test("updatedAt is never before createdAt", () => {
    for (let i = 0; i < 10; i++) {
      const p = profile({ seed: i });
      expect(new Date(p.updatedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(p.createdAt).getTime(),
      );
    }
  });
});

// ── campaign() ────────────────────────────────────────────────────────

describe("campaign()", () => {
  test("returns a valid Campaign with all required fields", () => {
    const c = campaign();
    expect(c.id).toBeDefined();
    expect(c.projectId).toBeDefined();
    expect(c.title).toBeDefined();
    expect(c.goalXLM).toBeDefined();
    expect(c.raisedXLM).toBeDefined();
    expect(c.deadline).toBeDefined();
    expect(typeof c.progressPercent).toBe("number");
    expect(typeof c.completed).toBe("boolean");
    expect(typeof c.active).toBe("boolean");
  });

  test("progressPercent and completed derive from overridden goalXLM/raisedXLM", () => {
    const c = campaign({ goalXLM: "100", raisedXLM: "100" });
    expect(c.progressPercent).toBe(100);
    expect(c.completed).toBe(true);
  });

  test("incomplete campaign when raised < goal", () => {
    const c = campaign({ goalXLM: "100", raisedXLM: "50" });
    expect(c.progressPercent).toBe(50);
    expect(c.completed).toBe(false);
  });
});

// ── milestone() ───────────────────────────────────────────────────────

describe("milestone()", () => {
  test("returns a valid Milestone with all required fields", () => {
    const m = milestone();
    expect(m.id).toBeDefined();
    expect(m.projectId).toBeDefined();
    expect(typeof m.percentage).toBe("number");
    expect(m.title).toBeDefined();
    expect(m.createdAt).toBeDefined();
  });
});

// ── update() ──────────────────────────────────────────────────────────

describe("update()", () => {
  test("returns a valid ProjectUpdate with all required fields", () => {
    const u = update();
    expect(u.id).toBeDefined();
    expect(u.projectId).toBeDefined();
    expect(u.title).toBeDefined();
    expect(u.body).toBeDefined();
    expect(u.createdAt).toBeDefined();
  });
});

// ── queueItem() ───────────────────────────────────────────────────────

describe("queueItem()", () => {
  test("returns a valid QueueItem with all required fields", () => {
    const q = queueItem();
    expect(q.id).toBeDefined();
    expect(["donation", "profile_update", "follow"]).toContain(q.type);
    expect(["pending", "sent", "failed"]).toContain(q.status);
    expect(q.createdAt).toBeDefined();
    expect(q.retryCount).toBeGreaterThanOrEqual(0);
    expect(q.maxRetries).toBeGreaterThan(0);
  });

  test("deterministic: same seed produces identical output", () => {
    const a = queueItem({ id: "q-1" });
    const b = queueItem({ id: "q-1" });
    expect(a).toEqual(b);
  });
});

// ── apiResponse() / paginatedResponse() ───────────────────────────────

describe("apiResponse()", () => {
  test("wraps data in { success: true, data }", () => {
    const p = project();
    const res = apiResponse(p);
    expect(res.success).toBe(true);
    expect(res.data).toEqual(p);
  });
});

describe("paginatedResponse()", () => {
  test("wraps items in { success: true, data, next_cursor, has_more }", () => {
    const items = [project(), project()];
    const res = paginatedResponse(items);
    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(2);
    expect(res.next_cursor).toBeNull();
    expect(res.has_more).toBe(false);
  });
});

// ── timeline() ────────────────────────────────────────────────────────

describe("timeline()", () => {
  test("returns the requested number of entries", () => {
    const tl = timeline("proj-1", 5);
    expect(tl).toHaveLength(5);
  });

  test("each entry has donation, project, matchedAmount, runningTotal", () => {
    const tl = timeline("proj-1", 3);
    for (const entry of tl) {
      expect(entry.donation).toBeDefined();
      expect(entry.project.id).toBe("proj-1");
      expect(typeof entry.runningTotal).toBe("string");
    }
  });

  test("running totals are monotonically increasing", () => {
    const tl = timeline("proj-1", 10);
    for (let i = 1; i < tl.length; i++) {
      expect(parseFloat(tl[i].runningTotal)).toBeGreaterThanOrEqual(
        parseFloat(tl[i - 1].runningTotal),
      );
    }
  });

  test("accepts pre-supplied donations", () => {
    const d1 = donation({ projectId: "proj-x", amountXLM: "10" });
    const d2 = donation({ projectId: "proj-x", amountXLM: "20" });
    const tl = timeline("proj-x", 0, { donations: [d1, d2] });
    expect(tl).toHaveLength(2);
    expect(tl[0].donation.id).toBe(d1.id);
    expect(tl[1].donation.id).toBe(d2.id);
  });
});

// ── rng.pick() edge case ─────────────────────────────────────────────

describe("createRNG()", () => {
  test("pick() throws on empty array", () => {
    const rng = createRNG(42);
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
