"use strict";

const config = require("./retentionPolicies");

describe("retentionPolicies config", () => {
  test("every policy validates at load time", () => {
    expect(config.policies.length).toBeGreaterThan(0);
    config.policies.forEach((p, i) =>
      expect(() => config.validatePolicy(p, i)).not.toThrow(),
    );
  });

  test("policies never target donations or audit logs", () => {
    const forbidden = new Set(["donations", "admin_audit_log"]);
    config.policies.forEach((p) =>
      expect(forbidden.has(p.table)).toBe(false),
    );
  });

  test("byName returns the policy or null", () => {
    expect(config.byName("device-tokens-delete").table).toBe("device_tokens");
    expect(config.byName("nope")).toBeNull();
  });

  test("only delete and anonymize strategies are permitted", () => {
    config.policies.forEach((p) =>
      expect(["delete", "anonymize"]).toContain(p.strategy),
    );
  });

  test("anonymize policies declare anonymizeFields within the allow-list", () => {
    config.policies
      .filter((p) => p.strategy === "anonymize")
      .forEach((p) => {
        expect(p.anonymizeFields.length).toBeGreaterThan(0);
        p.anonymizeFields.forEach((c) =>
          expect(config.ALLOWED_COLUMNS.has(c)).toBe(true),
        );
      });
  });

  test("table names are within the allow-list", () => {
    config.policies.forEach((p) =>
      expect(config.ALLOWED_TABLES.has(p.table)).toBe(true),
    );
  });

  test("invalid table fails validation", () => {
    const bad = {
      name: "bad",
      table: "donations",
      strategy: "delete",
      retentionPeriod: { value: 1, unit: "days" },
      condition: "1=1",
    };
    expect(() => config.validatePolicy(bad, 0)).toThrow(/allow-list/);
  });

  test("invalid identifier in anonymizeFields fails validation", () => {
    const bad = {
      name: "bad",
      table: "project_subscriptions",
      strategy: "anonymize",
      retentionPeriod: { value: 1, unit: "days" },
      condition: "1=1",
      anonymizeFields: ["email; DROP TABLE donations--"],
      anonymizedAtColumn: "anonymised_at",
    };
    expect(() => config.validatePolicy(bad, 0)).toThrow(/identifier/);
  });
});
