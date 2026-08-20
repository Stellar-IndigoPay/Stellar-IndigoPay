"use strict";

const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { requireDonorAuth } = require("../middleware/donorAuth");
const { AppError } = require("../errors");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { enqueueExportJob, getJobStatus } = require("../services/dsr/dsrQueue");

const dsrLimiter = createRateLimiter(5, 60); // 5 requests per hour

/**
 * POST /api/dsr/export
 * Enqueues an export job for the authenticated donor.
 */
router.post("/export", dsrLimiter, requireDonorAuth, async (req, res, next) => {
  try {
    const { donorAddress } = req;
    
    // Enqueue the export job via dsrQueue
    const jobId = await enqueueExportJob(donorAddress);

    res.status(202).json({
      success: true,
      data: {
        jobId,
        message: "Data export request received and is being processed."
      }
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/dsr/export/:jobId
 * Returns the status of the export job and the download URL if completed.
 */
router.get("/export/:jobId", requireDonorAuth, async (req, res, next) => {
  try {
    const { jobId } = req.params;
    const { donorAddress } = req;

    const job = await getJobStatus(jobId);
    
    if (!job) {
      throw new AppError("NOT_FOUND", { detail: "Job not found" });
    }
    
    // Authorization check: ensure the job belongs to the authenticated donor
    if (job.name !== "dsr-export" || job.data.donorAddress !== donorAddress) {
      throw new AppError("UNAUTHORIZED", { detail: "You do not have permission to view this job" });
    }

    if (job.state === "completed") {
      res.json({
        success: true,
        data: {
          status: job.state,
          downloadUrl: job.output?.url,
          expiresAt: job.output?.expiresAt,
          completedAt: job.completedon
        }
      });
    } else if (job.state === "failed") {
      res.json({
        success: true,
        data: {
          status: job.state,
          error: "The export job failed to complete."
        }
      });
    } else {
      res.json({
        success: true,
        data: {
          status: job.state, // e.g., 'created', 'active', 'retry'
        }
      });
    }
  } catch (err) {
    next(err);
  }
});

const crypto = require("crypto");
const redis = require("../services/redis");
const { sendErasureOtpEmail } = require("../services/email");

/**
 * POST /api/dsr/erasure/request
 * Initiates the two-step erasure flow.
 * Requires an email address to send the confirmation OTP to.
 */
router.post("/erasure/request", dsrLimiter, requireDonorAuth, async (req, res, next) => {
  try {
    const { donorAddress } = req;
    const { email } = req.body;

    if (!email) {
      throw new AppError("VALIDATION_ERROR", { detail: "Email is required to confirm erasure." });
    }

    // Generate a secure 6-digit OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const redisKey = `dsr_erasure_otp:${donorAddress}`;

    // Store in Redis with 15 minutes TTL
    await redis.set(redisKey, { otp, email }, 15 * 60);

    // Send the OTP via email
    await sendErasureOtpEmail({ to: email, otp });

    res.json({
      success: true,
      message: "An erasure confirmation code has been sent to your email."
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/dsr/erasure/confirm
 * Confirms the OTP and enqueues the erasure job.
 */
router.post("/erasure/confirm", dsrLimiter, requireDonorAuth, async (req, res, next) => {
  try {
    const { donorAddress } = req;
    const { otp } = req.body;

    if (!otp) {
      throw new AppError("VALIDATION_ERROR", { detail: "OTP is required." });
    }

    const redisKey = `dsr_erasure_otp:${donorAddress}`;
    const stored = await redis.get(redisKey);

    if (!stored || stored.otp !== String(otp).trim()) {
      throw new AppError("UNAUTHORIZED", { detail: "Invalid or expired confirmation code." });
    }

    // Valid OTP. Clean up.
    await redis.getClient().del(redisKey);

    // Enqueue the erasure job
    const { enqueueEraseJob } = require("../services/dsr/dsrQueue");
    const jobId = await enqueueEraseJob(donorAddress);

    res.json({
      success: true,
      message: "Data erasure request confirmed and is now being processed.",
      jobId
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
