"use strict";

const { getInventory, DONOR_DATA_CLASSES } = require("./dataInventory");
const retentionPolicies = require("../../config/retentionPolicies");

// Mock retentionPolicies so we can test both the success and failure paths
jest.mock("../../config/retentionPolicies", () => ({
  policies: []
}));

describe("dataInventory", () => {
  const originalPolicies = retentionPolicies.policies;

  beforeEach(() => {
    // Reset policies before each test
    retentionPolicies.policies = [];
  });

  test("A data class missing from retentionPolicies.js causes an explicit failure, not silent omission", () => {
    // With an empty mock, any standard class (like 'profiles') should throw
    expect(() => getInventory()).toThrow(/missing from retentionPolicies\.js/);
  });

  test("Every expected data class appears in the inventory and action matches retentionPolicies.js", () => {
    // Populate the mock with all required classes that aren't out of scope
    retentionPolicies.policies = DONOR_DATA_CLASSES
      .filter(c => !["donations", "on_chain_references", "audit_entries"].includes(c.name))
      .map((c, idx) => ({
        name: `policy-${idx}`,
        table: c.table,
        strategy: idx % 2 === 0 ? "delete" : "anonymize"
      }));

    const inventory = getInventory();
    
    // Check that every donor data class is represented
    expect(inventory.length).toBe(DONOR_DATA_CLASSES.length);
    
    // Check that each class's action matches the policy (or is out of scope)
    for (const item of inventory) {
      if (["donations", "on_chain_references", "audit_entries"].includes(item.name)) {
        expect(item.action).toBe("out_of_scope");
        expect(item.supportsErase).toBe(false);
      } else {
        const policy = retentionPolicies.policies.find(p => p.table === item.storageLocation);
        expect(item.action).toBe(policy.strategy);
        expect(item.supportsErase).toBe(true);
      }
    }
  });
});
