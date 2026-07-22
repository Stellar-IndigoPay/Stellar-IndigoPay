/**
 * src/routes/donations.js
 */
"use strict";
const EventEmitter = require("events");
const express = require("express");
const router = express.Router();
const { v4: uuid } = require("uuid");
const { z } = require("zod");
const logger = require("../logger");
const pool = require("../db/pool");
const { AppError } = require("../errors");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { validate } = require("../middleware/validate");
const idempotencyMiddleware = require("../middleware/idempotency");
const {
  donationSchema,
  stellarAddress,
  uuid: uuidValidator,
} = require("../validators/schemas");
const { mapDonationRow } = require("../services/store");
const { invalidateCache } = require("../middleware/cache");
const { enqueueProfileUpdate } = require("../services/profileQueue");
const { enqueueImpactRecalc } = require("../services/impactQueue");
const { enqueuePushNotification } = require("../services/pushQueue");
const { server } = require("../services/stellar");
const oracleService = require("../services/oracleService");
const { generateReceiptPdf, hashReceiptContent, signReceipt } = require("../services/receiptGenerator");
const { invalidateProjectRelatedCache } = require("../services/cacheManager");
const donationLimiter = createRateLimiter(10, 1); // 10 requests per minute

// Local EventEmitter used by both the POST /api/donations handler and the
// GET /api/donations/stream SSE endpoint to broadcast new donations in
// real time without going through Socket.IO.
const donationEvents = new EventEmitter();

function validateKey(k) {
  if (!k || !/^G[A-Z0-9]{55}$/.test(k)) {
    throw new AppError("INVALID_ADDRESS");
  }
}

function validateTxHash(h) {
  if (!h || !/^[a-fA-F0-9]{64}$/.test(h)) {
    throw new AppError("INVALID_TX_HASH");
  }
}

/**
 * Record a donation after an on-chain transaction is observed.
 *
 * Supports an optional `Idempotency-Key` request header (UUID v4).  When
 * supplied, the server stores the response and replays it on duplicate
 * requests within a 24-hour window, preventing double-recording of the same
 * donation.
 *
 * @route POST /api/donations
 * @param {import('express').Request} req - Express request containing the donation payload.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the persisted donation record or an error response.
 * @throws {Error} If validation, project lookup, or donation persistence fails.
 */
async function recordDonation(req, res, next) {
  let client;
  let inTransaction = false;

  try {
    const {
      projectId,
      donorAddress,
      amountXLM,
      amount,
      currency = "XLM",
      message,
      transactionHash,
      sourceAsset,
      conversionPath,
      convertedAmountXLM,
      anonymous = false,
    } = req.body;

    if (!donorAddress || !/^G[A-Z0-9]{55}$/.test(donorAddress)) {
      throw new AppError("INVALID_ADDRESS");
    }
    if (!transactionHash || !/^[a-fA-F0-9]{64}$/.test(transactionHash)) {
      throw new AppError("INVALID_TX_HASH");
    }

    client = await pool.connect();

    const projectResult = await client.query(
      "SELECT id FROM projects WHERE id = $1",
      [projectId],
    );
    if (!projectResult.rows[0]) {
      throw new AppError("PROJECT_NOT_FOUND");
    }

    // Determine numeric amount depending on currency
    const parsedAmount = parseFloat(
      currency === "XLM" ? (amountXLM ?? amount) : amount,
    );
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      throw new AppError("VALIDATION_ERROR", { field: "amount" });
    }

    // Deduplicate by tx hash
    const existingResult = await client.query(
      "SELECT * FROM donations WHERE transaction_hash = $1",
      [transactionHash],
    );
    if (existingResult.rows[0]) {
      return res.json({
        success: true,
        // Flag replayed idempotency keys so the client can treat the
        // submission as already-completed instead of re-queuing it.
        duplicate: true,
        data: mapDonationRow(existingResult.rows[0]),
      });
    }

    // Verify the transaction is confirmed on-chain before recording it.
    // Prevents a caller from inflating raised_xlm with a fake or unconfirmed tx hash.
    let onChainTx;
    try {
      onChainTx = await server.getTransaction(transactionHash);
    } catch {
      throw new AppError("TX_NOT_FOUND");
    }
    if (!onChainTx || onChainTx.successful !== true) {
      throw new AppError("TX_FAILED");
    }

    await client.query("BEGIN");
    inTransaction = true;

    // Lock the XLM/USD rate at recording time. A missing cached rate is
    // deliberately stored as NULL rather than inventing a value later.
    const fiatRate = currency === "XLM" ? oracleService.getCurrentPrice() : null;
    const fiatAmount = fiatRate ? parsedAmount * fiatRate : null;
    const donationResult = await client.query(
      `INSERT INTO donations (
        id, project_id, donor_address, amount_xlm, amount, currency, message,
        transaction_hash, source_asset, conversion_path, converted_amount_xlm,
        anonymous, fiat_amount_usd, fiat_rate_at_donation, created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NOW())
      RETURNING *`,
      [
        uuid(),
        projectId,
        donorAddress,
        currency === "XLM" ? parsedAmount : (convertedAmountXLM ? parseFloat(convertedAmountXLM) : null),
        parsedAmount,
        currency,
        message?.trim().slice(0, 100) || null,
        transactionHash,
        sourceAsset || null,
        conversionPath != null ? JSON.stringify(conversionPath) : null,
        convertedAmountXLM ? parseFloat(convertedAmountXLM) : null,
        Boolean(anonymous),
        fiatAmount,
        fiatRate,
      ],
    );

    const recordedDonation = donationResult.rows[0] || {
      id: uuid(),
      project_id: projectId,
      donor_address: donorAddress,
      amount_xlm: currency === "XLM" ? parsedAmount : (convertedAmountXLM ? parseFloat(convertedAmountXLM) : null),
      amount: parsedAmount,
      currency,
      message: message?.trim().slice(0, 100) || null,
      transaction_hash: transactionHash,
      source_asset: sourceAsset || null,
      conversion_path: conversionPath || null,
      converted_amount_xlm: convertedAmountXLM ? parseFloat(convertedAmountXLM) : null,
      created_at: new Date().toISOString(),
      anonymous: Boolean(anonymous),
      fiat_amount_usd: fiatAmount,
      fiat_rate_at_donation: fiatRate,
    };

    // Check for active matching offers
    if (currency === "XLM") {
      const matchesResult = await client.query(
        `SELECT id, matcher_address, cap_xlm, matched_xlm, multiplier
         FROM donation_matches
         WHERE project_id = $1
           AND status = 'active'
           AND expires_at > NOW()`,
        [projectId],
      );

      for (const match of matchesResult.rows) {
        const matchedXlm = Number.parseFloat(match.matched_xlm || "0");
        const capXlm = Number.parseFloat(match.cap_xlm);
        const remaining = capXlm - matchedXlm;

        if (remaining > 0) {
          const matchAmount = Math.min(
            parsedAmount * match.multiplier,
            remaining,
          );

          await client.query(
            `INSERT INTO donations (
              id, project_id, donor_address, amount_xlm, amount, currency, message, transaction_hash, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
            [
              uuid(),
              projectId,
              match.matcher_address,
              matchAmount,
              matchAmount,
              "XLM",
              `Matching donation for donation from ${donorAddress}`,
              `match-${transactionHash}-${match.id}`,
            ],
          );

          await client.query(
            "UPDATE donation_matches SET matched_xlm = matched_xlm + $1 WHERE id = $2",
            [matchAmount, match.id],
          );
        }
      }
    }

    // Update project totals — use converted XLM amount for path-payment donations
    const xlmIncrement =
      currency === "XLM"
        ? parsedAmount
        : convertedAmountXLM
          ? parseFloat(convertedAmountXLM)
          : 0;
    await client.query(
      `UPDATE projects
       SET raised_xlm = raised_xlm + $1::numeric,
           donor_count = (
             SELECT COUNT(DISTINCT donor_address)
             FROM donations
             WHERE project_id = $2
           ),
           updated_at = NOW()
       WHERE id = $2`,
      [xlmIncrement, projectId],
    );

    await client.query("COMMIT");
    inTransaction = false;

    if (!anonymous) enqueueProfileUpdate(donorAddress).catch((err) => {
      logger.error(
        { event: "profile_update_enqueue_failed", err, donorAddress },
        "Failed to enqueue profile update job",
      );
    });
    if (!anonymous) {
      enqueueProfileUpdate(donorAddress).catch((err) => {
        logger.error(
          { event: "profile_update_enqueue_failed", err, donorAddress },
          "Failed to enqueue profile update job",
        );
      });
    }

    enqueueImpactRecalc({
      donationId: recordedDonation.id,
      projectId,
      donorAddress,
      amountXLM: parsedAmount,
    }).catch((err) => {
      logger.error({ event: "impact_enqueue_failed", err: err.message, donorAddress, projectId }, "Failed to enqueue impact recalculation job");
    });
    enqueuePushNotification({
      type: "donation_receipt",
      payload: {
        donorAddress,
        projectId,
        donationId: recordedDonation.id,
        amount: parsedAmount,
        currency,
      },
    }).catch((err) => {
      logger.error(
        { event: "push_enqueue_failed", err: err.message, donorAddress, projectId },
        "Failed to enqueue donation receipt push notification",
      );
    });

    (req.log || logger).info(
      {
        event: "donation_recorded",
        amount: parsedAmount,
        currency,
        project: projectId,
        donor: donorAddress,
        txHash: transactionHash,
      },
      "Donation recorded",
    );

    const io = req.app?.get("io");
    if (io && typeof io.emit === "function") {
      io.emit("donation_event", {
        projectId,
        donorAddress,
        amountXLM: recordedDonation.amount_xlm,
        transactionHash,
        timestamp: new Date().toISOString(),
      });
    }

    await invalidateProjectRelatedCache(projectId);

    const mappedDonation = mapDonationRow(donationResult.rows[0]);
    if (anonymous) mappedDonation.donorAddress = null;
    donationEvents.emit("new_donation", mappedDonation);

    invalidateCache(`cache:v1:projects:detail:${projectId}`);
    invalidateCache("cache:v1:leaderboard:*");
    invalidateCache("cache:v1:stats:global");
    invalidateCache("cache:v1:impact:global");

    const responseBody = { success: true, data: mappedDonation };
    res.status(201).json(responseBody);
  } catch (e) {
    if (inTransaction && client) await client.query("ROLLBACK");
    next(e);
  } finally {
    if (client) client.release();
  }
}

/**
 * Register a donation via the public API.
 *
 * @route POST /api/donations
 * @param {import('express').Request} req - Express request containing the donation payload.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the created donation payload.
 * @throws {Error} If rate limiting or donation creation fails.
 */
router.post("/", donationLimiter, idempotencyMiddleware, validate(donationSchema), recordDonation);

// GET /api/donations/stream
router.get("/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    res.write(":\\n\\n");
  }, 15000);

  const onNewDonation = (donation) => {
    res.write(`data: ${JSON.stringify(donation)}\\n\\n`);
  };

  donationEvents.on("new_donation", onNewDonation);

  req.on("close", () => {
    clearInterval(keepAlive);
    donationEvents.off("new_donation", onNewDonation);
  });
});

// GET /api/donations/:id/receipt - return the immutable, signed tax receipt.
router.get("/:id/receipt", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!uuidValidator.safeParse(id).success) throw new AppError("VALIDATION_ERROR", { field: "id" });
    const existing = await pool.query(
      "SELECT pdf FROM donation_receipts WHERE donation_id = $1", [id],
    );
    if (existing.rows[0]) {
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="indigopay-receipt-${id}.pdf"`);
      return res.send(existing.rows[0].pdf);
    }
    const result = await pool.query(
      `SELECT d.*, p.name AS project_name, p.wallet_address, p.co2_offset_kg,
        CASE WHEN p.raised_xlm > 0 THEN d.amount_xlm * (p.co2_offset_kg::numeric / p.raised_xlm) ELSE 0 END AS co2_offset_kg
       FROM donations d JOIN projects p ON p.id = d.project_id WHERE d.id = $1`, [id],
    );
    const donation = result.rows[0];
    if (!donation) throw new AppError("DONATION_NOT_FOUND");
    if (donation.anonymous) throw new AppError("NOT_FOUND");
    const receiptId = uuid();
    const issuedAt = new Date().toISOString();
    const proof = JSON.stringify({ receiptId, donationId: id, transactionHash: donation.transaction_hash, issuedAt });
    const receiptHash = hashReceiptContent(proof);
    const signature = signReceipt(receiptHash);
    const pdf = generateReceiptPdf({ donation, project: { name: donation.project_name, wallet_address: donation.wallet_address }, receiptId, issuedAt, receiptHash, signature });
    await pool.query(
      `INSERT INTO donation_receipts (id, donation_id, receipt_hash, signature, pdf)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (donation_id) DO NOTHING`, [receiptId, id, receiptHash, signature, pdf],
    );
    await pool.query("UPDATE donations SET receipt_generated_at = NOW() WHERE id = $1", [id]);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="indigopay-receipt-${id}.pdf"`);
    return res.send(pdf);
  } catch (e) { return next(e); }
});

// GET /api/donations/project/:id
router.get("/project/:projectId/messages", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50);
    // Read from the donor_history projection (materialised donation stream).
    const result = await pool.query(
      `SELECT *
        FROM projection_donor_history
        WHERE project_id = $1
          AND message IS NOT NULL
          AND length(trim(message)) > 0
        ORDER BY amount_xlm DESC, created_at DESC
        LIMIT $2`,
      [req.params.projectId, limit],
    );
    res.json({ success: true, data: result.rows.map(mapDonationRow) });
  } catch (e) {
    next(e);
  }
});

/**
 * List donations for a specific project.
 *
 * @route GET /api/donations/project/:projectId
 * @param {import('express').Request} req - Express request containing the project id and pagination options.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the paginated donation history.
 * @throws {Error} If the donation query fails.
 */
router.get("/project/:projectId", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const hasCursor = Boolean(req.query.cursor);
    const values = hasCursor
      ? [req.params.projectId, req.query.cursor, limit + 1]
      : [req.params.projectId, limit + 1];

    // Read from the donor_history projection (materialised donation stream).
    const table = "projection_donor_history";
    const query = hasCursor
      ? `SELECT * FROM ${table}
         WHERE project_id = $1
           AND created_at < $2::timestamptz
         ORDER BY created_at DESC
         LIMIT $3`
      : `SELECT * FROM ${table}
         WHERE project_id = $1
         ORDER BY created_at DESC
         LIMIT $2`;

    const donations = (await pool.query(query, values)).rows.map(
      mapDonationRow,
    );
    const hasMore = donations.length > limit;
    const result = hasMore ? donations.slice(0, limit) : donations;
    const nextCursor = hasMore ? result[result.length - 1].createdAt : null;

    res.json({ success: true, data: result, nextCursor });
  } catch (e) {
    next(e);
  }
});

/**
 * List donations for a specific donor.
 *
 * @route GET /api/donations/donor/:publicKey
 * @param {import('express').Request} req - Express request containing the donor public key.
 * @param {import('express').Response} res - Express response object.
 * @param {import('express').NextFunction} next - Express error middleware.
 * @returns {Promise<void>} Sends the donor donation history.
 * @throws {Error} If validation or the donation query fails.
 */
router.get(
  "/donor/:publicKey",
  validate(z.object({ publicKey: stellarAddress }), "params"),
  async (req, res, next) => {
    try {
      // Read from the donor_history projection (materialised donation stream).
      const result = await pool.query(
        `SELECT * FROM projection_donor_history
        WHERE donor_address = $1
        ORDER BY created_at DESC`,
        [req.params.publicKey],
      );
      res.json({ success: true, data: result.rows.map(mapDonationRow) });
    } catch (e) {
      next(e);
    }
  });

// GET /api/donations/recurring/:donorAddress - fetch recurring schedules for a donor
router.get(
  "/recurring/:donorAddress",
  validate(z.object({ donorAddress: stellarAddress }), "params"),
  async (req, res, next) => {
    try {
      const result = await pool.query(
        `SELECT r.*, p.name AS project_name, p.wallet_address AS project_wallet
         FROM recurring_donations r
         JOIN projects p ON r.project_id = p.id
         WHERE r.donor_address = $1
         ORDER BY r.created_at DESC`,
        [req.params.donorAddress]
      );
      res.json({
        success: true,
        data: result.rows.map((row) => ({
          id: row.id,
          donorAddress: row.donor_address,
          recurringId: row.recurring_id,
          projectId: row.project_id,
          projectName: row.project_name,
          projectWallet: row.project_wallet,
          amount: parseFloat(row.amount),
          currency: row.currency,
          intervalSeconds: row.interval_seconds,
          nextExecutionAt: row.next_execution_at.toISOString(),
          keeperIncentive: parseFloat(row.keeper_incentive),
          active: row.active,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        })),
      });
    } catch (e) {
      next(e);
    }
  }
);

// GET /api/donations/:id - single donation fetch endpoint
router.get("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    // Basic UUID validation
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        id,
      )
    ) {
      throw new AppError("VALIDATION_ERROR", { field: "id", message: "Invalid donation ID" });
    }

    const USDC_TO_XLM_RATE = parseFloat(process.env.USDC_TO_XLM_RATE || "8.0");
    const query = `
      SELECT 
        d.*,
        p.name AS project_name,
        pr.display_name AS donor_display_name,
        CASE
          WHEN d.currency = 'USDC' AND p.raised_xlm > 0
            THEN (d.amount * ${USDC_TO_XLM_RATE} * (p.co2_offset_kg::numeric / p.raised_xlm))
          WHEN d.currency = 'XLM' AND p.raised_xlm > 0
            THEN (d.amount_xlm * (p.co2_offset_kg::numeric / p.raised_xlm))
          ELSE 0
        END AS co2_offset_kg
      FROM donations d
      JOIN projects p ON d.project_id = p.id
      LEFT JOIN profiles pr ON d.donor_address = pr.public_key
      WHERE d.id = $1
    `;
    const result = await pool.query(query, [id]);

    if (!result.rows[0]) {
      throw new AppError("DONATION_NOT_FOUND");
    }
    const row = result.rows[0];
    const donationData = mapDonationRow(row);
    donationData.projectName = row.project_name;
    donationData.donorDisplayName = row.donor_display_name || null;
    donationData.co2OffsetKg = Math.round(
      Number.parseFloat(row.co2_offset_kg || "0"),
    );

    res.json({ success: true, data: donationData });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
module.exports.recordDonation = recordDonation;
