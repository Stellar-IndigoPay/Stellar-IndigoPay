"use strict";

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const {
  generateReceiptPdf,
  signReceipt,
  hashReceiptContent,
  RECEIPT_DOMAIN_SEPARATOR,
} = require("./receiptGenerator");

describe("receiptGenerator", () => {
  afterEach(() => {
    delete process.env.RECEIPT_SIGNING_KEY;
  });

  test("hashReceiptContent domain-separates the content", () => {
    const content = JSON.stringify({ receiptId: "abc", donationId: "def" });
    const separated = crypto
      .createHash("sha256")
      .update(RECEIPT_DOMAIN_SEPARATOR + content)
      .digest("hex");
    const plain = crypto.createHash("sha256").update(content).digest("hex");

    expect(hashReceiptContent(content)).toBe(separated);
    expect(hashReceiptContent(content)).not.toBe(plain);
  });

  test("signReceipt produces a verifiable Ed25519 signature over the hash", () => {
    const keypair = Keypair.random();
    process.env.RECEIPT_SIGNING_KEY = keypair.secret();
    const receiptHash = hashReceiptContent("some receipt content");
    const signature = signReceipt(receiptHash);

    // 64-byte Ed25519 signature, hex-encoded
    expect(signature).toMatch(/^[0-9a-f]{128}$/);
    expect(
      keypair.verify(
        Buffer.from(receiptHash, "hex"),
        Buffer.from(signature, "hex"),
      ),
    ).toBe(true);
  });

  test("signReceipt throws when RECEIPT_SIGNING_KEY is not configured", () => {
    expect(() => signReceipt("abc")).toThrow(
      "RECEIPT_SIGNING_KEY is not configured",
    );
  });

  test("generateReceiptPdf embeds the commitment and signature", () => {
    const pdf = generateReceiptPdf({
      donation: {
        amount_xlm: "10",
        fiat_amount_usd: "5.00",
        donor_address: "GDONOR",
        transaction_hash: "txhash",
        ledger_number: 123,
        created_at: "2026-08-15T00:00:00Z",
        co2_offset_kg: 1.5,
      },
      project: { name: "Reforestation", wallet_address: "GPROJ" },
      receiptId: "rid-1",
      issuedAt: "2026-08-15T00:00:00Z",
      receiptHash: "deadbeef",
      signature: "cafe",
    });
    const text = pdf.toString("utf8");
    // PDF content streams escape parentheses in text-showing operators.
    expect(text).toContain("Receipt commitment \\(SHA-256\\): deadbeef");
    expect(text).toContain("Ed25519 signature: cafe");
  });
});