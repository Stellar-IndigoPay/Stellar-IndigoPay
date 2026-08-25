"use strict";

/**
 * services/keyRotationManager.js
 *
 * Key rotation management for webhook signing secrets.
 *
 * Handles automatic key-version expiry after grace period and manages
 * the lifecycle of webhook signing keys during rotation.
 */

const logger = require("../logger");
const { isKeyExpired, generateKeyId, GRACE_PERIOD_DAYS } = require("../lib/webhookSign");
const { getMultiVersionSigningSecrets } = require("./signingSecretProvider");

/**
 * Check if any keys have expired and should be cleaned up.
 *
 * @returns {Promise<{expiredKeys: string[], activeKeys: string[]}>}
 */
async function checkExpiredKeys() {
  try {
    const secrets = await getMultiVersionSigningSecrets();
    const now = new Date();

    const expiredKeys = [];
    const activeKeys = [];

    // Check current key
    if (secrets.keyId && isKeyExpired(secrets.keyId, now)) {
      expiredKeys.push(secrets.keyId);
    } else if (secrets.keyId) {
      activeKeys.push(secrets.keyId);
    }

    // In a full implementation, we would also check previous and next key IDs
    // For now, we only track the current key ID

    return { expiredKeys, activeKeys };
  } catch (err) {
    logger.error(
      { event: "key_expiry_check_failed", err: err.message },
      "Failed to check expired keys",
    );
    return { expiredKeys: [], activeKeys: [] };
  }
}

/**
 * Generate a new key version for rotation.
 *
 * @param {number} version the new version number
 * @param {Date} timestamp the creation timestamp (defaults to now)
 * @returns {string} the new key ID
 */
function generateNewKeyVersion(version = 1, timestamp = new Date()) {
  return generateKeyId(version, timestamp);
}

/**
 * Calculate the grace period end date for a key.
 *
 * @param {Date} keyCreationDate the date the key was created
 * @returns {Date} the date when the grace period ends
 */
function calculateGracePeriodEnd(keyCreationDate) {
  return new Date(
    keyCreationDate.getTime() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000,
  );
}

/**
 * Validate key rotation state - ensures we have proper current/previous/next
 * key structure for safe rotation.
 *
 * @param {object} secrets the multi-version secrets object
 * @returns {boolean} true if the rotation state is valid
 */
function validateRotationState(secrets) {
  // Must have a current secret
  if (!secrets.current || typeof secrets.current !== "string") {
    return false;
  }

  // If we have a previous secret, we should have a key ID for it
  if (secrets.previous && !secrets.keyId) {
    return false;
  }

  // Current secret should not be empty
  if (secrets.current.trim().length === 0) {
    return false;
  }

  return true;
}

/**
 * Prepare secrets for rotation - creates the structure needed for
 * dual-version signing with proper key IDs.
 *
 * @param {string} newSecret the new current secret
 * @param {string} oldSecret the old secret (becomes previous)
 * @param {number} newVersion the new version number
 * @returns {object} the structured secrets object
 */
function prepareRotationSecrets(newSecret, oldSecret, newVersion = 1) {
  const now = new Date();
  const newKeyId = generateNewKeyVersion(newVersion, now);

  return {
    current: newSecret,
    previous: oldSecret || null,
    next: null, // Would be set during next rotation
    keyId: newKeyId,
  };
}

module.exports = {
  checkExpiredKeys,
  generateNewKeyVersion,
  calculateGracePeriodEnd,
  validateRotationState,
  prepareRotationSecrets,
  GRACE_PERIOD_DAYS,
};