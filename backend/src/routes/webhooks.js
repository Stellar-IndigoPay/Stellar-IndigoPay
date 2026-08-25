/**
 * src/routes/webhooks.js
 *
 * Webhook key management endpoints for dual-version key rotation.
 *
 * Provides:
 * - GET /api/webhooks/keys - Returns active key IDs for webhook signature verification
 */
"use strict";

const express = require("express");
const router = express.Router();
const logger = require("../logger");
const { getMultiVersionSigningSecrets } = require("../services/signingSecretProvider");
const { isKeyExpired } = require("../lib/webhookSign");

/**
 * GET /api/webhooks/keys
 *
 * Returns the active webhook signing key IDs for signature verification.
 * This endpoint allows webhook receivers to discover which key versions are
 * currently valid for verifying webhook signatures.
 *
 * Response includes:
 * - current: the primary key ID used for new signatures
 * - previous: the previous key ID (still valid during grace period)
 * - next: the next key ID (for forward compatibility)
 * - expiresAt: when the current key will expire
 */
router.get("/keys", async (req, res, next) => {
  try {
    const secrets = await getMultiVersionSigningSecrets();

    const now = new Date();
    const currentKeyId = secrets.keyId || "v1";

    // Calculate expiration date (7 days from key creation)
    const parsedKeyId = currentKeyId.match(/^v(\d+)-(\d{4}-\d{2}-\d{2})$/);
    let expiresAt = null;
    if (parsedKeyId) {
      const keyDate = new Date(parsedKeyId[2]);
      const gracePeriodDays = 7;
      expiresAt = new Date(keyDate.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
    }

    const response = {
      success: true,
      data: {
        current: currentKeyId,
        previous: secrets.previous ? `v0` : null, // We don't track previous key IDs in current implementation
        next: secrets.next ? `v2` : null, // We don't track next key IDs in current implementation
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      },
    };

    logger.info(
      { event: "webhook_keys_requested", currentKeyId },
      "Webhook keys requested",
    );

    res.json(response);
  } catch (err) {
    logger.error(
      { event: "webhook_keys_error", err: err.message },
      "Failed to retrieve webhook keys",
    );
    next(err);
  }
});

module.exports = router;