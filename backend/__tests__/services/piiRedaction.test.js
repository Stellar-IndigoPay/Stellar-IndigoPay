/**
 * __tests__/services/piiRedaction.test.js
 *
 * Regression tests for PII scrubbing and digest payload masking.
 */
"use strict";

const {
  hashDonorId,
  redactPiiValue,
  scrubDigestPayload,
  scrubAnalyticsRow,
} = require("../../src/config/pii");

describe("PII redaction helpers", () => {
  test("hashes donor identifiers with a stable token", () => {
    const tokenA = hashDonorId("GABC1234567890XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
    const tokenB = hashDonorId("GABC1234567890XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX");

    expect(tokenA).toBe(tokenB);
    expect(tokenA).not.toContain("GABC123");
    expect(tokenA).toMatch(/^[a-f0-9]{64}$/);
  });

  test("redacts email and wallet values before they hit analytics or exports", () => {
    expect(redactPiiValue("email", "alice@example.com")).not.toContain("alice@example.com");
    expect(redactPiiValue("donor_address", "GABC1234567890XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX")).not.toContain("GABC123");
  });

  test("scrubs digest payloads and analytics rows by field name and known PII patterns", () => {
    const payload = {
      donorAddress: "GABC1234567890XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      email: "alice@example.com",
      projectNames: ["Forest Restore"],
      recentDonations: [{ projectName: "Forest Restore", amountXLM: 12.5 }],
    };

    const scrubbed = scrubDigestPayload(payload);
    const analyticsRow = scrubAnalyticsRow({ donor_address: payload.donorAddress, email: payload.email, project_id: "proj-1" });

    expect(scrubbed.donorAddress).not.toContain("GABC123");
    expect(scrubbed.email).not.toContain("alice@example.com");
    expect(JSON.stringify(scrubbed)).not.toMatch(/alice@example.com|G[A-Z2-7]{55}/);
    expect(analyticsRow.donor_address).not.toContain("GABC123");
    expect(analyticsRow.email).not.toContain("alice@example.com");
  });
});
