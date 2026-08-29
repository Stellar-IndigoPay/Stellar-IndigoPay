/**
 * src/routes/auth.js — donor authentication endpoints (issue #1102)
 *
 * GET /api/auth/challenge
 *   Issues a single-use, expiring nonce for the challenge/response donor-auth
 *   flow. The donor signs `nonce + method + path` with their Stellar keypair
 *   and sends the result via X-Donor-Address / X-Donor-Nonce /
 *   X-Donor-Signature on every donor-authenticated request.
 */
"use strict";

const express = require("express");
const router = express.Router();
const { issueDonorChallenge } = require("../middleware/donorAuth");
const { createRateLimiter } = require("../middleware/rateLimiter");

// 30 challenges per minute — generous for normal clients, bounds nonce-churn.
const challengeLimiter = createRateLimiter(30, 1);

/**
 * @route GET /api/auth/challenge
 * @returns {{success: true, data: {nonce: string, expiresAt: string}}}
 */
router.get("/challenge", challengeLimiter, async (req, res, next) => {
  try {
    const { nonce, expiresAt } = await issueDonorChallenge();
    res.json({ success: true, data: { nonce, expiresAt } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
