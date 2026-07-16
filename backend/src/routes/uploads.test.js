"use strict";

const request = require("supertest");
const app = require("../server");
const pool = require("../db/pool");
const { v4: uuid } = require("uuid");
const { metrics } = require("../services/metrics");
const fs = require("fs");
const path = require("path");
const os = require("os");

const TEST_WALLET = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
let projectId;

beforeAll(async () => {
  // Create a project to test quotas and linking
  projectId = uuid();
  await pool.query(
    `INSERT INTO projects (id, name, description, category, location, wallet_address, goal_xlm)
     VALUES ($1, 'Upload Test', 'Desc', 'Other', 'Earth', $2, 100)`,
    [projectId, TEST_WALLET]
  );
});

afterAll(async () => {
  await pool.query("DELETE FROM projects WHERE id = $1", [projectId]);
  await pool.end();
});

beforeEach(async () => {
  await pool.query("DELETE FROM project_uploads");
  metrics.uploadSuccessTotal.reset();
  metrics.uploadRejectedTotal.reset();
  metrics.virusScanTotal.reset();
});

describe("Uploads Security Hardening", () => {
  it("should reject a file with mismatched MIME type", async () => {
    const res = await request(app)
      .post("/api/uploads")
      .attach("file", Buffer.from("a,b,c"), {
        filename: "test.pdf",
        contentType: "application/pdf", // declares PDF
      });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("MIME_MISMATCH");
  });

  it("should accept an orphan valid PDF", async () => {
    // Valid PDF magic bytes: %PDF-
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a, 0x01, 0x02]);
    const res = await request(app)
      .post("/api/uploads")
      .attach("file", pdfBuffer, {
        filename: "test.pdf",
        contentType: "application/pdf",
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.key).toBeDefined();
    
    // Check it's recorded as orphan
    const uploads = await pool.query("SELECT * FROM project_uploads");
    expect(uploads.rows.length).toBe(1);
    expect(uploads.rows[0].project_id).toBeNull();
  });

  it("should reject an EICAR malware signature", async () => {
    // Note: If ClamAV is running in CI, this will be rejected. 
    // If not running, it might fail open (or closed, depending on CLAMD_FAIL_OPEN).
    // The EICAR test string:
    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    
    // We send it as text/plain so it bypasses magic byte checks and goes straight to ClamAV.
    const res = await request(app)
      .post("/api/uploads")
      .attach("file", eicar, {
        filename: "eicar.txt",
        contentType: "text/plain",
      });

    // We assume ClamAV is running and active in the test environment
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VIRUS_DETECTED");
  });

  it("should enforce per-project quota and deduplicate uploads", async () => {
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a, 0x01, 0x02, 0x03]);
    
    // 1. Upload first file linked to project
    const res1 = await request(app)
      .post("/api/uploads")
      .field("projectId", projectId)
      .field("walletAddress", TEST_WALLET)
      .attach("file", pdfBuffer, {
        filename: "test1.pdf",
        contentType: "application/pdf",
      });

    expect(res1.status).toBe(201);
    expect(res1.body.success).toBe(true);
    const key1 = res1.body.data.key;

    // 2. Upload SAME file (same sha256) - should deduplicate
    const res2 = await request(app)
      .post("/api/uploads")
      .field("projectId", projectId)
      .field("walletAddress", TEST_WALLET)
      .attach("file", pdfBuffer, {
        filename: "test2.pdf",
        contentType: "application/pdf",
      });

    expect(res2.status).toBe(200); // 200 instead of 201 for deduplication
    expect(res2.body.data.deduplicated).toBe(true);
    expect(res2.body.data.key).toBe(key1); // Should return existing key

    // 3. Upload multiple files to hit quota
    // Max 20 files per project. We'll bypass the route to insert 20 files directly
    // to simulate the quota being reached.
    for (let i = 0; i < 20; i++) {
      await pool.query(
        `INSERT INTO project_uploads (id, project_id, storage_key, original_name, mime_type, size_bytes, sha256_hash, uploaded_by)
         VALUES ($1, $2, $3, 'file', 'application/pdf', 10, $4, $5)`,
        [uuid(), projectId, `dummy-key-${i}`, `dummy-hash-${i}`, TEST_WALLET]
      );
    }

    // Attempt to upload 21st file
    const pdfBuffer2 = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a, 0x01, 0x02, 0x04]);
    const res3 = await request(app)
      .post("/api/uploads")
      .field("projectId", projectId)
      .field("walletAddress", TEST_WALLET)
      .attach("file", pdfBuffer2, {
        filename: "test3.pdf",
        contentType: "application/pdf",
      });

    expect(res3.status).toBe(413);
    expect(res3.body.error).toBe("Upload quota exceeded");
    expect(res3.body.code).toBe("QUOTA_EXCEEDED");
  });

  it("should fetch a project's uploads", async () => {
    const pdfBuffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x0a]);
    await request(app)
      .post("/api/uploads")
      .field("projectId", projectId)
      .field("walletAddress", TEST_WALLET)
      .attach("file", pdfBuffer, {
        filename: "test4.pdf",
        contentType: "application/pdf",
      });

    const res = await request(app)
      .get(`/api/projects/${projectId}/uploads`)
      .query({ walletAddress: TEST_WALLET });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].originalName).toBe("test4.pdf");
  });
});
