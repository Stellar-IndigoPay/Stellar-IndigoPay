"use strict";

const crypto = require("crypto");
const { Keypair } = require("@stellar/stellar-sdk");

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
    "Verify on Stellar Expert: https://stellar.expert/explorer/testnet/tx/" + donation.transaction_hash,
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

module.exports = { generateReceiptPdf, signReceipt, hashReceiptContent };
