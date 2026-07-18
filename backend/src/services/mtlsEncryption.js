"use strict";

/**
 * src/services/mtlsEncryption.js
 *
 * Encrypts / decrypts the client private key used for mutual-TLS webhook
 * delivery. We use AES-256-GCM with a server-side key derived from
 * WEBHOOK_MTLS_ENCRYPTION_KEY (hex-encoded, stored in Secrets Manager).
 *
 * GCM provides authenticated encryption, so tampering with the ciphertext or
 * IV is detected at decryption time via the auth tag. The 16-byte auth tag is
 * appended to the ciphertext and stored alongside a per-encryption random IV
 * (the IV is never reused across encryptions, which is what keeps GCM nonce
 * requirements satisfied).
 */

const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getEncryptionKey() {
  const raw = process.env.WEBHOOK_MTLS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "WEBHOOK_MTLS_ENCRYPTION_KEY is not set — cannot encrypt mTLS private keys",
    );
  }
  const key = Buffer.from(raw, "hex");
  if (key.length !== 32) {
    throw new Error(
      "WEBHOOK_MTLS_ENCRYPTION_KEY must be a 64-hex-character (32-byte) key",
    );
  }
  return key;
}

/**
 * Encrypt a PEM-encoded client private key.
 *
 * @param {string} pemKey PEM-encoded private key.
 * @returns {{ encrypted: string, iv: string }} base64 ciphertext (tag appended) + base64 IV.
 */
function encryptPrivateKey(pemKey) {
  if (typeof pemKey !== "string" || pemKey.length === 0) {
    throw new Error("Cannot encrypt an empty private key");
  }
  const ENCRYPTION_KEY = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, ENCRYPTION_KEY, iv);
  const encrypted = Buffer.concat([
    cipher.update(pemKey, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: Buffer.concat([encrypted, tag]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

/**
 * Decrypt a PEM-encoded client private key produced by `encryptPrivateKey`.
 *
 * @param {string} encrypted base64 ciphertext with appended auth tag.
 * @param {string} iv base64 IV used at encryption time.
 * @returns {string} the PEM-encoded private key.
 */
function decryptPrivateKey(encrypted, iv) {
  if (typeof encrypted !== "string" || typeof iv !== "string") {
    throw new Error("Missing encrypted key or IV");
  }
  const ENCRYPTION_KEY = getEncryptionKey();
  const buffer = Buffer.from(encrypted, "base64");
  const tag = buffer.subarray(-AUTH_TAG_LENGTH);
  const data = buffer.subarray(0, -AUTH_TAG_LENGTH);
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    ENCRYPTION_KEY,
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(tag);
  return decipher.update(data, undefined, "utf8") + decipher.final("utf8");
}

module.exports = {
  ALGORITHM,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  encryptPrivateKey,
  decryptPrivateKey,
};
