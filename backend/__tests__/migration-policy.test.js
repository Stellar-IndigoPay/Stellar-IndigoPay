const path = require("path");
const { validateMigrationText } = require("../scripts/validate-migrations");

describe("expand-contract migration policy", () => {
  it("flags NOT NULL additions without a default", () => {
    const source = `
      module.exports = {
        phase: "expand",
        async up(client) {
          await client.query("ALTER TABLE credits ADD COLUMN status TEXT NOT NULL");
        }
      };
    `;

    const result = validateMigrationText(source, "example.js");
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "not-null-without-default" }),
      ]),
    );
  });

  it("flags rename column operations", () => {
    const source = `
      module.exports = {
        phase: "expand",
        async up(client) {
          await client.query("ALTER TABLE credits RENAME COLUMN old_name TO new_name");
        }
      };
    `;

    const result = validateMigrationText(source, "example.js");
    expect(result).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "rename-column" }),
      ]),
    );
  });

  it("allows contract-phase drops and requires explicit phase metadata", () => {
    const source = `
      module.exports = {
        phase: "contract",
        dualWrite: true,
        async up(client) {
          await client.query("ALTER TABLE credits DROP COLUMN legacy_name");
        }
      };
    `;

    const result = validateMigrationText(source, "example.js");
    expect(result).toEqual([]);
  });
});
