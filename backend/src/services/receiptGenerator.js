"use strict";

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");
const redis = require("./redis");
const logger = require("../logger");

function escapePdf(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/** Create a small, dependency-free, standards-compliant one-page PDF receipt. */
function generateReceiptPdf({ donation, project, receiptId, issuedAt, receiptHash, signature }) {
  const amountXlm = donation.amount_xlm || donation.converted_amount_xlm || donation.amount;
  const fiat = donation.fiat_amount_usd == null ? "Pending price" : `$${Number(donation.fiat_amount_usd).toFixed(2)} USD`;
  const lines = [
    "IndigoPay | Climate Donation Tax Receipt",
    `Receipt ID: ${receiptId}`,
    `Issued: ${new Date(issuedAt).toISOString()}`,
    `Donor: ${donation.donor_address}`,
    `Project: ${project.name}`,
    `Project wallet: ${project.wallet_address}`,
    `Donation: ${amountXlm} XLM (${fiat})`,
    `Transaction hash: ${donation.transaction_hash}`,
    `Ledger: ${donation.ledger_number || "Not recorded"}`,
    `Donation date: ${new Date(donation.created_at).toISOString()}`,
    `CO2 offset estimate: ${Number(donation.co2_offset_kg || 0).toFixed(2)} kg`,
    "Verify on Stellar Expert: https://stellar.expert/explorer/" +
      (process.env.STELLAR_NETWORK === "mainnet" ? "public" : "testnet") +
      "/tx/" + donation.transaction_hash,
    `Receipt SHA-256: ${receiptHash}`,
    `Ed25519 signature: ${signature}`,
    "The transaction proof and signature above allow independent verification.",
  ];
  const stream = lines.map((line, i) => `BT /F1 9 Tf 50 ${760 - i * 42} Td (${escapePdf(line)}) Tj ET`).join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const startXref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, "0")} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF`;
  return Buffer.from(pdf, "utf8");
}

function signReceipt(receiptHash) {
  if (!process.env.RECEIPT_SIGNING_KEY) throw new Error("RECEIPT_SIGNING_KEY is not configured");
  return Keypair.fromSecret(process.env.RECEIPT_SIGNING_KEY)
    .sign(Buffer.from(receiptHash, "hex")).toString("hex");
}

function hashReceiptContent(content) { return crypto.createHash("sha256").update(content).digest("hex"); }

// ── Content-hash caching + request coalescing ───────────────────────────────
//
// A donation row is immutable once inserted (no updated_at column — see
// schema.sql), so a receipt's content never changes for a given donation.
// That makes (donationId, transactionHash) a valid, permanent cache key.
//
// This sits IN FRONT OF the durable Postgres cache (the `donation_receipts`
// table, unchanged by this file) as a faster path that also avoids a DB
// round-trip on repeat requests, and coalesces concurrent first-time
// requests for the same donation so a burst of simultaneous requests
// results in at most one generate() call per process, not one per request.

const RECEIPT_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days — receipts are immutable once issued
// Bump this if the PDF template/content shape ever changes, to naturally
// invalidate old cached bytes without an explicit cache-clear step.
const RECEIPT_CACHE_VERSION = "v1";

// In-process map of in-flight generation promises, keyed by content hash.
// Process-local only: in a multi-instance deployment, two DIFFERENT
// instances can each still generate once on a cold cache — the durable
// Postgres cache (and the re-read-after-insert in getOrGenerateReceiptPdf)
// is what keeps that consistent; this map is what prevents duplicate work
// within a single instance's request burst.
const inFlightGenerations = new Map();

function computeReceiptCacheKey(donationId, transactionHash) {
  const hash = crypto
    .createHash("sha256")
    .update(`${RECEIPT_CACHE_VERSION}:${donationId}:${transactionHash}`)
    .digest("hex");
  return `cache:v1:receipt:${hash}`;
}

async function getCachedReceiptPdf(cacheKey) {
  const cached = await redis.get(cacheKey);
  if (!cached || typeof cached !== "string") return null;
  try {
    return Buffer.from(cached, "base64");
  } catch {
    return null;
  }
}

async function cacheReceiptPdf(cacheKey, pdfBuffer) {
  await redis.set(cacheKey, pdfBuffer.toString("base64"), RECEIPT_CACHE_TTL_SECONDS);
}

/**
 * Return a donation's receipt PDF, generating it only if necessary.
 * Checks the Redis content-hash cache first, then coalesces with any
 * in-flight generation for the same key, and only calls `generate()` if
 * neither applies.
 *
 * @param {string} donationId
 * @param {string} transactionHash
 * @param {() => Promise<Buffer>} generate - called at most once per content
 *   hash per process (per cache-cold period). Expected to itself check the
 *   durable Postgres cache before doing real generation work, and to
 *   return the PDF as a Buffer either way.
 * @returns {Promise<{ pdf: Buffer, source: "redis" | "coalesced" | "generated" }>}
 */
async function getOrGenerateReceiptPdf(donationId, transactionHash, generate) {
  const cacheKey = computeReceiptCacheKey(donationId, transactionHash);

  const cached = await getCachedReceiptPdf(cacheKey);
  if (cached) {
    return { pdf: cached, source: "redis" };
  }

  const existingGeneration = inFlightGenerations.get(cacheKey);
  if (existingGeneration) {
    const pdf = await existingGeneration;
    return { pdf, source: "coalesced" };
  }

  const generationPromise = (async () => {
    try {
      const pdf = await generate();
      cacheReceiptPdf(cacheKey, pdf).catch((err) => {
        logger.warn(
          { event: "receipt_cache_write_failed", donationId, err: err.message },
          "Failed to cache generated receipt PDF",
        );
      });
      return pdf;
    } finally {
      inFlightGenerations.delete(cacheKey);
    }
  })();

  inFlightGenerations.set(cacheKey, generationPromise);
  const pdf = await generationPromise;
  return { pdf, source: "generated" };
}

module.exports = {
  generateReceiptPdf,
  signReceipt,
  hashReceiptContent,
  computeReceiptCacheKey,
  getOrGenerateReceiptPdf,
};