"use strict";

/**
 * Rule-engine matrix for the project-update moderation pipeline (issue #935).
 * The engine is pure and deterministic — every test asserts a fixed
 * decision for a fixed input, because that determinism is what makes the
 * results auditable and re-runnable.
 */

const {
  runRuleScreening,
  extractUrls,
  hostnameOf,
  DECISION,
  SEVERITY,
} = require("./screeningRules");

describe("URL helpers", () => {
  test("extracts http(s) and www URLs and strips trailing punctuation", () => {
    expect(extractUrls("See http://a.com/x. and https://b.io/y!"))
      .toEqual(["http://a.com/x", "https://b.io/y"]);
  });

  test("returns an empty list when there are no URLs", () => {
    expect(extractUrls("no links here")).toEqual([]);
  });

  test("normalises hostname casing and strips www and path", () => {
    expect(hostnameOf("https://WWW.Example.com/foo")).toEqual({
      host: "example.com",
      port: "",
      protocol: "https:",
    });
  });
});

describe("Hard violations (decision = QUARANTINE)", () => {
  test("raw-IP host URLs are hard phishing", () => {
    const result = runRuleScreening({
      title: "Bonus",
      body: "Connect your wallet at http://10.0.0.1/verify",
    });
    expect(result.decision).toBe(DECISION.QUARANTINE);
    expect(result.ruleHits).toContainEqual(
      expect.objectContaining({
        rule: "phishing.raw_ip_host",
        severity: SEVERITY.HARD,
      }),
    );
    expect(result.confidence).toBe(1);
  });

  test("lookalike brand domains are hard phishing, even around a www prefix", () => {
    const result = runRuleScreening({
      title: "Bonus round",
      body: "Connect your wallet at http://paypal-confirm-now.xyz/verify",
    });
    expect(result.decision).toBe(DECISION.QUARANTINE);
    expect(result.ruleHits.some((h) => h.rule === "phishing.lookalike_domain")).toBe(
      true,
    );
    expect(
      result.ruleHits.some(
        (h) => h.rule === "phishing.lookalike_credential_framing",
      ),
    ).toBe(true);
  });

  test("shortened-link + credential phrase is a hard phishing signal", () => {
    const result = runRuleScreening({
      title: "Urgent",
      body: "Verify your wallet now — https://bit.ly/3xzyz?token=1",
    });
    expect(result.decision).toBe(DECISION.QUARANTINE);
    expect(result.ruleHits).toContainEqual(
      expect.objectContaining({ rule: "phishing.shortened_credential_phrase" }),
    );
  });
});

describe("Soft signals (decision = REVIEW)", () => {
  test("profanity only ever triggers a soft review", () => {
    const result = runRuleScreening({
      title: "Things went badly",
      body: "What a fucking mess this week.",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
    expect(result.ruleHits.some((h) => h.rule === "profanity.detected")).toBe(true);
  });

  test("caps + money spam is flagged for review, never auto-quarantined", () => {
    const result = runRuleScreening({
      title: "WIN $$$",
      body: "MAKE MONEY FAST $5000 EVERY WEEK",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
    expect(result.ruleHits.some((h) => h.rule === "spam.shouted_money")).toBe(true);
  });

  test("the generic 'stellar' token is a soft review, not auto-quarantine", () => {
    const result = runRuleScreening({
      title: "Network guidance",
      body: "Community note at http://stellar-wallet-security.io",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
    expect(result.ruleHits.some((h) => h.rule === "phishing.lookalike_domain")).toBe(
      true,
    );
    expect(result.ruleHits.some((h) => h.severity === SEVERITY.HARD)).toBe(false);
  });

  test("repeated punctuation is a soft signal", () => {
    const result = runRuleScreening({
      title: "Update!!!",
      body: "Great progress everyone...!!!",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
  });

  test("credential phrases without any link stay soft", () => {
    const result = runRuleScreening({
      title: "Important",
      body: "An official announcement — no link required. Verify your wallet rules apply.",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
    expect(result.ruleHits.some((h) => h.severity === SEVERITY.HARD)).toBe(false);
  });

  test("buzz-phrase spam content goes to review with the phrase recorded", () => {
    const result = runRuleScreening({
      title: "Earn",
      body: "Make $5000 a day guaranteed profit — no risk.",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
    expect(result.ruleHits.some((h) => h.rule === "spam.buzz_phrase")).toBe(true);
  });
});

describe("Clean fast path (decision = APPROVED)", () => {
  test("ordinary update copy passes without an alert", () => {
    const result = runRuleScreening({
      title: "We planted 500 trees",
      body: "Big milestone for the grove. Thank you for the support.",
    });
    expect(result.decision).toBe(DECISION.APPROVED);
    expect(result.ruleHits).toEqual([]);
  });

  test("an allowlisted benign link stays clean", () => {
    const result = runRuleScreening({
      title: "Repo moved",
      body: "Check the source at https://github.com/stellar/soroban-tools.",
    });
    expect(result.decision).toBe(DECISION.APPROVED);
  });

  test("a link-density soft hit still returns REVIEW, not APPROVED", () => {
    const result = runRuleScreening({
      title: "links",
      body: "https://a.example.com/x https://b.example.com/y https://c.example.com/z",
    });
    expect(result.decision).toBe(DECISION.REVIEW);
    expect(result.ruleHits.some((h) => h.rule === "spam.link_density")).toBe(true);
  });
});