"use strict";

/**
 * 025_webhook_mtls
 *
 * Adds per-project mutual-TLS configuration for webhook delivery. Enterprise
 * partners that require mTLS present us with a CA certificate to verify their
 * server and expect IndigoPay to present a client certificate. The client
 * private key is stored AES-256-GCM encrypted (the encryption key is derived
 * from WEBHOOK_MTLS_ENCRYPTION_KEY and sourced from Secrets Manager).
 *
 * Only one mTLS configuration may exist per project (UNIQUE on project_id).
 */
module.exports = {
  name: "025_webhook_mtls",

  async up(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS webhook_mtls_config (
        id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        project_id           UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE UNIQUE,
        enabled              BOOLEAN NOT NULL DEFAULT false,
        ca_cert              TEXT,
        client_cert          TEXT,
        client_key_encrypted TEXT,
        client_key_iv        TEXT,
        cert_expires_at      TIMESTAMPTZ,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_webhook_mtls_project
      ON webhook_mtls_config(project_id)
    `);
  },

  async down(client) {
    await client.query("DROP TABLE IF EXISTS webhook_mtls_config");
  },
};
