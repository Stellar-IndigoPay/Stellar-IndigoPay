"use strict";

const express = require("express");
const request = require("supertest");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

// Generate a real self-signed certificate + key via openssl so the PEM
// parses with crypto.X509Certificate (used for expiry extraction). No real
// secret material is committed.
function certMaterial() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtls-test-"));
  const keyPath = path.join(tmp, "key.pem");
  const csrPath = path.join(tmp, "csr.pem");
  const certPath = path.join(tmp, "cert.pem");

  execFileSync("openssl", ["genrsa", "-traditional", "-out", keyPath, "2048"]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-key",
    keyPath,
    "-subj",
    "/CN=test.indigopay.local",
    "-out",
    csrPath,
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    csrPath,
    "-signkey",
    keyPath,
    "-days",
    "365",
    "-out",
    certPath,
  ]);

  const clientKey = fs.readFileSync(keyPath, "utf8");
  const clientCert = fs.readFileSync(certPath, "utf8");
  fs.rmSync(tmp, { recursive: true, force: true });

  return { caCert: clientCert, clientCert, clientKey };
}

jest.mock("../../db/pool", () => ({ query: jest.fn() }));
jest.mock("../../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));
jest.mock("../../services/audit", () => ({
  logAdminAction: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../../db/pool");
const { logAdminAction } = require("../../services/audit");

process.env.ADMIN_API_KEY = "test-admin-key";
process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/admin/webhooks", require("./webhooks"));
  return app;
}

describe("Admin Webhook mTLS Router", () => {
  let app;
  let mat;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    mat = certMaterial();
  });

  test("POST /:projectId/mtls returns 401 without auth", async () => {
    const res = await request(app)
      .post("/api/admin/webhooks/proj/mtls")
      .send({ caCert: mat.caCert, clientCert: mat.clientCert, clientKey: mat.clientKey });
    expect(res.status).toBe(401);
  });

  test("POST /:projectId/mtls uploads and upserts config", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post("/api/admin/webhooks/proj/mtls")
      .set("X-Admin-Key", "test-admin-key")
      .send({
        caCert: mat.caCert,
        clientCert: mat.clientCert,
        clientKey: mat.clientKey,
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.cert_expires_at).toBeDefined();

    const insertCall = pool.query.mock.calls.find((c) =>
      String(c[0]).toUpperCase().includes("INSERT INTO WEBHOOK_MTLS_CONFIG"),
    );
    expect(insertCall).toBeDefined();
    // Encrypted key is stored, not the raw PEM.
    expect(insertCall[1][3]).not.toBe(mat.clientKey);
    expect(logAdminAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: "webhook.mtls.update" }),
    );
  });

  test("POST /:projectId/mtls rejects invalid PEM", async () => {
    const res = await request(app)
      .post("/api/admin/webhooks/proj/mtls")
      .set("X-Admin-Key", "test-admin-key")
      .send({
        caCert: "not a pem",
        clientCert: mat.clientCert,
        clientKey: mat.clientKey,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/PEM/);
  });

  test("POST /:projectId/mtls rejects missing client key", async () => {
    const res = await request(app)
      .post("/api/admin/webhooks/proj/mtls")
      .set("X-Admin-Key", "test-admin-key")
      .send({ caCert: mat.caCert, clientCert: mat.clientCert });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  test("GET /:projectId/mtls returns null when no config", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .get("/api/admin/webhooks/proj/mtls")
      .set("X-Admin-Key", "test-admin-key");
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
  });

  test("GET /:projectId/mtls returns non-sensitive config without private key", async () => {
    pool.query.mockResolvedValue({
      rows: [
        {
          enabled: true,
          has_ca: true,
          has_client_cert: true,
          has_client_key: true,
          cert_expires_at: new Date(),
          created_at: new Date(),
          updated_at: new Date(),
        },
      ],
    });
    const res = await request(app)
      .get("/api/admin/webhooks/proj/mtls")
      .set("X-Admin-Key", "test-admin-key");
    expect(res.status).toBe(200);
    expect(res.body.data.has_client_key).toBe(true);
    expect(res.body.data.client_key_encrypted).toBeUndefined();
  });

  test("POST /:projectId/mtls/disable sets enabled=false", async () => {
    pool.query.mockResolvedValue({ rowCount: 1 });
    const res = await request(app)
      .post("/api/admin/webhooks/proj/mtls/disable")
      .set("X-Admin-Key", "test-admin-key");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const updateCall = pool.query.mock.calls.find((c) =>
      String(c[0]).toUpperCase().includes("UPDATE WEBHOOK_MTLS_CONFIG"),
    );
    expect(updateCall).toBeDefined();
    expect(String(updateCall[0]).toUpperCase()).toContain("ENABLED = FALSE");
  });

  test("POST /:projectId/mtls/test returns 400 when not enabled", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const res = await request(app)
      .post("/api/admin/webhooks/proj/mtls/test")
      .set("X-Admin-Key", "test-admin-key");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not enabled/);
  });
});
