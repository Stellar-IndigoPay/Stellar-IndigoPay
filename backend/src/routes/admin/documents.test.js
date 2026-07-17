/**
 * admin/documents.test.js — Admin document integrity verification route
 *
 * The storage service is mocked; these tests cover auth, param handling,
 * response shape, and audit logging for GET /api/admin/documents/:cid/verify.
 */
"use strict";

const express = require("express");
const request = require("supertest");

jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../services/storage", () => ({
  verifyIPFSDocument: jest.fn(),
}));

const { logAdminAction } = require("../../services/audit");
const { verifyIPFSDocument } = require("../../services/storage");
const { AppError } = require("../../errors");

process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

const FAKE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/documents", require("./documents"));
  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json(err.toJSON());
    }
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

describe("GET /api/admin/documents/:cid/verify", () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test("returns 401 without admin auth", async () => {
    const res = await request(app).get(
      `/api/admin/documents/${FAKE_CID}/verify`,
    );
    expect(res.status).toBe(401);
    expect(verifyIPFSDocument).not.toHaveBeenCalled();
  });

  test("verifies a document and returns the integrity result", async () => {
    verifyIPFSDocument.mockResolvedValue({
      valid: true,
      cid: FAKE_CID,
      hash: "a".repeat(64),
      size: 1024,
    });

    const res = await request(app)
      .get(`/api/admin/documents/${FAKE_CID}/verify`)
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.valid).toBe(true);
    expect(res.body.data.hash).toBe("a".repeat(64));
    expect(verifyIPFSDocument).toHaveBeenCalledWith(FAKE_CID, {
      fileName: undefined,
      expectedSha256: undefined,
    });
  });

  test("supports /verify/:cid as an alias", async () => {
    verifyIPFSDocument.mockResolvedValue({ valid: true, cid: FAKE_CID });

    const res = await request(app)
      .get(`/api/admin/documents/verify/${FAKE_CID}`)
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(verifyIPFSDocument).toHaveBeenCalledWith(FAKE_CID, {
      fileName: undefined,
      expectedSha256: undefined,
    });
  });

  test("passes ?name and ?sha256 through to the verifier", async () => {
    verifyIPFSDocument.mockResolvedValue({
      valid: true,
      cid: FAKE_CID,
      hash: "b".repeat(64),
      size: 10,
      matches: true,
    });

    const res = await request(app)
      .get(
        `/api/admin/documents/${FAKE_CID}/verify?name=methodology.pdf&sha256=${"b".repeat(64)}`,
      )
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.data.matches).toBe(true);
    expect(verifyIPFSDocument).toHaveBeenCalledWith(FAKE_CID, {
      fileName: "methodology.pdf",
      expectedSha256: "b".repeat(64),
    });
  });

  test("ignores a malformed ?sha256 param", async () => {
    verifyIPFSDocument.mockResolvedValue({ valid: true, cid: FAKE_CID });

    await request(app)
      .get(`/api/admin/documents/${FAKE_CID}/verify?sha256=not-a-hash`)
      .set("X-Admin-Key", "test-admin-key");

    expect(verifyIPFSDocument).toHaveBeenCalledWith(FAKE_CID, {
      fileName: undefined,
      expectedSha256: undefined,
    });
  });

  test("returns 400 for an invalid CID", async () => {
    verifyIPFSDocument.mockResolvedValue({
      valid: false,
      error: "Invalid CID",
    });

    const res = await request(app)
      .get("/api/admin/documents/notacid/verify")
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
    expect(res.body.error.detail).toBe("Invalid CID");
  });

  test("reports valid=false when the document is not retrievable", async () => {
    verifyIPFSDocument.mockResolvedValue({
      valid: false,
      error: "Document not retrievable (HTTP 404)",
    });

    const res = await request(app)
      .get(`/api/admin/documents/${FAKE_CID}/verify`)
      .set("X-Admin-Key", "test-admin-key");

    expect(res.status).toBe(200);
    expect(res.body.data.valid).toBe(false);
    expect(res.body.data.error).toMatch(/not retrievable/);
  });

  test("records an audit log entry for the verification", async () => {
    verifyIPFSDocument.mockResolvedValue({ valid: true, cid: FAKE_CID });

    await request(app)
      .get(`/api/admin/documents/${FAKE_CID}/verify?name=doc.pdf`)
      .set("X-Admin-Key", "test-admin-key");

    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "document.verify",
        targetType: "ipfs_document",
        targetId: FAKE_CID,
        metadata: expect.objectContaining({ valid: true, fileName: "doc.pdf" }),
      }),
    );
  });
});
