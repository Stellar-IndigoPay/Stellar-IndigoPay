"use strict";

/**
 * Unit tests for mtlsEncryption.js.
 *
 * We generate throwaway RSA keys at runtime so no real secret material is
 * committed to the repo (gitleaks allowlists *.test.js anyway).
 */

const crypto = require("crypto");
const {
  encryptPrivateKey,
  decryptPrivateKey,
  IV_LENGTH,
  AUTH_TAG_LENGTH,
  ALGORITHM,
} = require("./mtlsEncryption");

function makeTestKey() {
  return crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  }).privateKey;
}

// A stable 32-byte key for all tests.
const TEST_KEY = crypto.randomBytes(32).toString("hex");

beforeAll(() => {
  process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = TEST_KEY;
});

describe("mtlsEncryption", () => {
  test("round-trips a PEM private key", () => {
    const pem = makeTestKey();
    const { encrypted, iv } = encryptPrivateKey(pem);
    const decrypted = decryptPrivateKey(encrypted, iv);
    expect(decrypted).toBe(pem);
  });

  test("produces base64 outputs", () => {
    const { encrypted, iv } = encryptPrivateKey(makeTestKey());
    expect(Buffer.from(encrypted, "base64").toString("base64")).toBe(encrypted);
    expect(Buffer.from(iv, "base64").toString("base64")).toBe(iv);
  });

  test("uses a fresh random IV each time (nonce uniqueness)", () => {
    const pem = makeTestKey();
    const a = encryptPrivateKey(pem);
    const b = encryptPrivateKey(pem);
    expect(a.iv).not.toBe(b.iv);
  });

  test("IV has the expected length (16 bytes)", () => {
    const { iv } = encryptPrivateKey(makeTestKey());
    expect(Buffer.from(iv, "base64").length).toBe(IV_LENGTH);
  });

  test("ciphertext length equals plaintext + auth tag", () => {
    const pem = makeTestKey();
    const { encrypted } = encryptPrivateKey(pem);
    const ct = Buffer.from(encrypted, "base64");
    // encrypted PEM length varies; auth tag is always appended.
    expect(ct.length).toBe(Buffer.byteLength(pem) + AUTH_TAG_LENGTH);
  });

  test("rejects decryption with the wrong key (tamper detection)", () => {
    const pem = makeTestKey();
    const { encrypted, iv } = encryptPrivateKey(pem);
    const wrongKey = crypto.randomBytes(32).toString("hex");
    const saved = process.env.WEBHOOK_MTLS_ENCRYPTION_KEY;
    process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = wrongKey;
    try {
      expect(() => decryptPrivateKey(encrypted, iv)).toThrow();
    } finally {
      process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = saved;
    }
  });

  test("throws when encrypting an empty key", () => {
    expect(() => encryptPrivateKey("")).toThrow(/empty private key/i);
  });

  test("throws when encrypting a non-string key", () => {
    expect(() => encryptPrivateKey(null)).toThrow(/empty private key/i);
  });

  test("throws when decrypting with a tampered ciphertext (auth tag fails)", () => {
    const pem = makeTestKey();
    const { encrypted, iv } = encryptPrivateKey(pem);
    const buf = Buffer.from(encrypted, "base64");
    // flip a byte in the ciphertext body (not the tag)
    buf[0] ^= 0xff;
    expect(() => decryptPrivateKey(buf.toString("base64"), iv)).toThrow();
  });

  test("throws when the encryption key env var is missing", () => {
    const saved = process.env.WEBHOOK_MTLS_ENCRYPTION_KEY;
    delete process.env.WEBHOOK_MTLS_ENCRYPTION_KEY;
    try {
      expect(() => encryptPrivateKey(makeTestKey())).toThrow(
        /WEBHOOK_MTLS_ENCRYPTION_KEY/,
      );
    } finally {
      process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = saved;
    }
  });

  test("throws when the encryption key has the wrong length", () => {
    const saved = process.env.WEBHOOK_MTLS_ENCRYPTION_KEY;
    process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = "00"; // 1 byte
    try {
      expect(() => encryptPrivateKey(makeTestKey())).toThrow(/64-hex/);
    } finally {
      process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = saved;
    }
  });

  test("uses aes-256-gcm algorithm", () => {
    expect(ALGORITHM).toBe("aes-256-gcm");
  });
});
