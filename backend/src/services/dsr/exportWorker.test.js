"use strict";

const { processExportJob } = require("./exportWorker");
const pool = require("../../db/pool");
const storage = require("../storage");

jest.mock("../../db/pool", () => ({
  query: jest.fn()
}));

jest.mock("../storage", () => ({
  uploadFile: jest.fn()
}));

describe("exportWorker", () => {
  const donorAddress = "G1234567890";

  beforeEach(() => {
    jest.clearAllMocks();
    
    // Mock pool query to return some mock data for tables
    pool.query.mockImplementation(async (sql, params) => {
      if (sql.includes("FROM profiles")) {
        return { rows: [{ public_key: donorAddress, display_name: "Test" }] };
      }
      if (sql.includes("FROM project_subscriptions")) {
        return { rows: [{ email: "test@example.com", donor_address: donorAddress }] };
      }
      return { rows: [] };
    });

    storage.uploadFile.mockResolvedValue({
      url: "http://localhost:3000/api/uploads/test-key.json",
      backend: "local",
      key: "test-key.json",
      size: 100,
      contentType: "application/json"
    });
  });

  test("processExportJob assembles archive with manifest and out-of-scope markers", async () => {
    const job = { data: { donorAddress } };
    
    const result = await processExportJob(job);
    
    expect(result.url).toBe("http://localhost:3000/api/uploads/test-key.json");
    expect(result.key).toBe("test-key.json");
    expect(result.expiresAt).toBeDefined();

    // Verify uploadFile was called with JSON buffer containing the manifest
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    const [buffer, fileName, contentType] = storage.uploadFile.mock.calls[0];
    
    expect(fileName).toMatch(/export-G1234567890-\d+\.json/);
    expect(contentType).toBe("application/json");

    const json = JSON.parse(buffer.toString("utf8"));
    
    expect(json._manifest).toBeDefined();
    expect(json._manifest.donorAddress).toBe(donorAddress);
    
    // Verify out-of-scope classes are explicitly handled in manifest
    expect(json._manifest.classes.donations.action).toBe("out_of_scope");
    expect(json._manifest.classes.donations.included).toBe(true);

    expect(json._manifest.classes.audit_entries.action).toBe("out_of_scope");
    expect(json._manifest.classes.audit_entries.included).toBe(false);

    // Verify in-scope classes have data
    expect(json.profiles).toBeDefined();
    expect(json.profiles.length).toBe(1);
    expect(json.profiles[0].display_name).toBe("Test");

    expect(json.project_subscriptions).toBeDefined();
    expect(json.project_subscriptions.length).toBe(1);

    expect(result.rowCount).toBeGreaterThan(0);
  });
});
