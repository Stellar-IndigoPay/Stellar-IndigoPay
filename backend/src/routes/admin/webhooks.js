"use strict";

/**
 * src/routes/admin/webhooks.js — Admin mTLS configuration for webhooks
 *
 * Enterprise partners can require mutual-TLS for inbound webhook delivery.
 * This router lets an admin upload (and rotate) per-project mTLS material:
 * the partner's CA certificate, our client certificate, and our client
 * private key (stored AES-256-GCM encrypted). A GET endpoint exposes the
 * current config (excluding the private key) so the admin UI can render
 * certificate status and expiry.
 *
 * Mounted at /api/admin/webhooks (via admin.js -> router.use("/webhooks")).
 *
 * Public surface:
 *   - GET  /:projectId/mtls      -> current config (no private key)
 *   - POST /:projectId/mtls      -> upsert config + enable mTLS
 *   - POST /:projectId/mtls/disable -> disable mTLS without deleting material
 *   - POST /:projectId/mtls/test -> fire a test delivery over mTLS
 */

"use strict";

const crypto = require("crypto");
const express = require("express");
const router = express.Router();
const pool = require("../../db/pool");
const { adminRequired } = require("../../middleware/auth");
const { logAdminAction } = require("../../services/audit");
const { encryptPrivateKey, decryptPrivateKey } = require("../../services/mtlsEncryption");

/**
 * Validate that a string looks like a PEM block. We accept CERTIFICATE and
 * (encrypted or unencrypted) PRIVATE KEY / RSA / EC variants. This is a
 * structural sanity check, not full chain validation — Node's tls module
 * does the real verification at connect time.
 */
function validatePEM(pem, label) {
  if (typeof pem !== "string" || pem.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  const re = /-----BEGIN [A-Z0-9 ]+-----[\s\S]+?-----END [A-Z0-9 ]+-----/;
  if (!re.test(pem.trim())) {
    throw new Error(`${label} is not a valid PEM block`);
  }
}

/**
 * Extract the expiry timestamp from a client certificate. Throws if the PEM
 * cannot be parsed as an X509Certificate (Node 16+).
 */
function extractCertExpiry(clientCert) {
  const cert = new crypto.X509Certificate(clientCert);
  // validTo is a string like "Dec 31 23:59:59 2030 GMT".
  const expiresAt = new Date(cert.validTo);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new Error("Could not parse client certificate validity period");
  }
  if (expiresAt.getTime() < Date.now()) {
    throw new Error("Client certificate has already expired");
  }
  return expiresAt;
}

// GET /:projectId/mtls — return non-sensitive config for the admin UI.
router.get("/:projectId/mtls", adminRequired, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT enabled, ca_cert IS NOT NULL AS has_ca,
              client_cert IS NOT NULL AS has_client_cert,
              client_key_encrypted IS NOT NULL AS has_client_key,
              cert_expires_at, created_at, updated_at
         FROM webhook_mtls_config
        WHERE project_id = $1`,
      [req.params.projectId],
    );
    if (rows.length === 0) {
      return res.json({ success: true, data: null });
    }
    return res.json({ success: true, data: rows[0] });
  } catch (err) {
    next(err);
  }
});

// POST /:projectId/mtls — upsert + enable mTLS config.
router.post("/:projectId/mtls", adminRequired, async (req, res, next) => {
  try {
    const { caCert, clientCert, clientKey } = req.body || {};

    validatePEM(clientCert, "clientCert");
    validatePEM(clientKey, "clientKey");
    if (caCert !== undefined && caCert !== null && caCert !== "") {
      validatePEM(caCert, "caCert");
    }

    const expiresAt = extractCertExpiry(clientCert);
    const { encrypted, iv } = encryptPrivateKey(clientKey);

    await pool.query(
      `INSERT INTO webhook_mtls_config
         (project_id, enabled, ca_cert, client_cert, client_key_encrypted, client_key_iv, cert_expires_at)
       VALUES ($1, true, $2, $3, $4, $5, $6)
       ON CONFLICT (project_id) DO UPDATE SET
         enabled = true,
         ca_cert = $2,
         client_cert = $3,
         client_key_encrypted = $4,
         client_key_iv = $5,
         cert_expires_at = $6,
         updated_at = now()`,
      [
        req.params.projectId,
        caCert || null,
        clientCert,
        encrypted,
        iv,
        expiresAt,
      ],
    );

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "webhook.mtls.update",
      targetType: "project",
      targetId: req.params.projectId,
      metadata: { cert_expires_at: expiresAt.toISOString() },
      ipAddress: req.ip,
    });

    return res.json({ success: true, data: { cert_expires_at: expiresAt } });
  } catch (err) {
    if (/PEM|certificate|required/i.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

// POST /:projectId/mtls/disable — stop using mTLS without dropping material.
router.post("/:projectId/mtls/disable", adminRequired, async (req, res, next) => {
  try {
    const { rowCount } = await pool.query(
      `UPDATE webhook_mtls_config SET enabled = false, updated_at = now()
        WHERE project_id = $1`,
      [req.params.projectId],
    );

    await logAdminAction({
      actor: req.admin?.sub || "admin",
      action: "webhook.mtls.disable",
      targetType: "project",
      targetId: req.params.projectId,
      metadata: {},
      ipAddress: req.ip,
    });

    return res.json({ success: true, updated: rowCount });
  } catch (err) {
    next(err);
  }
});

// POST /:projectId/mtls/test — perform a real mTLS handshake against the
// project's configured webhook_url and report success/failure. This imports
// the queue worker lazily to reuse its agent-building logic without coupling
// route tests to the full worker.
router.post("/:projectId/mtls/test", adminRequired, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT wm.enabled, wm.ca_cert, wm.client_cert, wm.client_key_encrypted, wm.client_key_iv, p.webhook_url
         FROM webhook_mtls_config wm
         JOIN projects p ON p.id = wm.project_id
        WHERE wm.project_id = $1`,
      [req.params.projectId],
    );
    const cfg = rows[0];
    if (!cfg || !cfg.enabled) {
      return res.status(400).json({ error: "mTLS is not enabled for this project" });
    }
    if (!cfg.webhook_url) {
      return res.status(400).json({ error: "Project has no webhook_url configured" });
    }

    const https = require("https");
    const { URL } = require("url");
    const urlObj = new URL(cfg.webhook_url);
    if (urlObj.protocol !== "https:") {
      return res.status(400).json({ error: "webhook_url must be https for mTLS test" });
    }

    const agent = new https.Agent({
      cert: cfg.client_cert,
      key: decryptPrivateKey(cfg.client_key_encrypted, cfg.client_key_iv),
      ca: cfg.ca_cert || undefined,
      rejectUnauthorized: true,
    });

    const result = await new Promise((resolve) => {
      const reqTls = https.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port || 443,
          path: urlObj.pathname + urlObj.search || "/",
          method: "POST",
          agent,
          timeout: 10000,
          headers: { "Content-Type": "application/json" },
        },
        (r) => {
          r.resume();
          r.on("end", () => resolve({ ok: true, statusCode: r.statusCode }));
        },
      );
      reqTls.on("error", (e) => resolve({ ok: false, error: e.message }));
      reqTls.on("timeout", () => {
        reqTls.destroy();
        resolve({ ok: false, error: "timeout" });
      });
      reqTls.end(JSON.stringify({ type: "mtls.test", ok: true }));
    });
    agent.destroy();

    if (result.ok) {
      return res.json({ success: true, data: { statusCode: result.statusCode } });
    }
    return res.status(502).json({ success: false, error: result.error });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
