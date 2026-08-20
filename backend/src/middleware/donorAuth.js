"use strict";

const { Keypair } = require("@stellar/stellar-sdk");
const { AppError } = require("../errors");

/**
 * Middleware to verify that the request is authorized by the donor.
 * Expects headers:
 *   X-Donor-Address: The Stellar public key (G...)
 *   X-Timestamp: Current UNIX timestamp (must be within 5 minutes)
 *   X-Signature: Ed25519 signature (base64 or hex) of the timestamp string
 */
function requireDonorAuth(req, res, next) {
  try {
    const donorAddress = req.headers["x-donor-address"];
    const timestamp = req.headers["x-timestamp"];
    const signature = req.headers["x-signature"];

    if (!donorAddress || !timestamp || !signature) {
      throw new AppError("UNAUTHORIZED", { detail: "Missing donor authentication headers" });
    }

    const ts = parseInt(timestamp, 10);
    if (isNaN(ts) || Math.abs(Date.now() - ts) > 5 * 60 * 1000) {
      throw new AppError("UNAUTHORIZED", { detail: "Timestamp expired or invalid" });
    }

    const keypair = Keypair.fromPublicKey(donorAddress);
    
    // Try verifying as hex, fallback to base64 if needed
    let isValid = false;
    try {
      isValid = keypair.verify(Buffer.from(timestamp), Buffer.from(signature, "hex"));
    } catch {
      try {
        isValid = keypair.verify(Buffer.from(timestamp), Buffer.from(signature, "base64"));
      } catch {
        // invalid format
      }
    }

    if (!isValid) {
      throw new AppError("UNAUTHORIZED", { detail: "Invalid signature" });
    }

    req.donorAddress = donorAddress;
    next();
  } catch (err) {
    if (err instanceof AppError) {
      next(err);
    } else {
      next(new AppError("UNAUTHORIZED", { detail: "Invalid donor authentication payload" }));
    }
  }
}

module.exports = {
  requireDonorAuth
};
