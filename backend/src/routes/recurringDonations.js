/**
 * src/routes/recurringDonations.js
 * Recurring donation subscription API routes.
 *
 * POST   /api/recurring-donations     — create a recurring donation
 * GET    /api/recurring-donations/:donorAddress — list donor's subscriptions
 * DELETE /api/recurring-donations/:id — cancel a subscription
 */
"use strict";
const express = require("express");
const router = express.Router();
const pool = require("../db/pool");
const { Contract, nativeToScVal, rpc, TransactionBuilder, BASE_FEE, Networks } = require("@stellar/stellar-sdk");
const logger = require("../logger");

const CONTRACT_ID = process.env.CONTRACT_ID || "";
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || "testnet";
const RPC_URL = process.env.SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = STELLAR_NETWORK === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
const rpcServer = new rpc.Server(RPC_URL);

const STROOP = 10_000_000;
const MIN_INTERVAL_LEDGERS = 43_200;
const MAX_PAYMENTS = 60;

// POST /api/recurring-donations
// Creates a recurring donation subscription. Expects an already-signed
// Soroban contract call to create_subscription, or we build the XDR for
// the donor to sign.
router.post("/", async (req, res, next) => {
  try {
    const { donorAddress, projectId, amount, intervalLedgers, maxPayments, signedXDR } = req.body;

    if (!donorAddress || typeof donorAddress !== "string") {
      return res.status(400).json({ error: "donorAddress is required" });
    }
    if (!projectId || typeof projectId !== "string") {
      return res.status(400).json({ error: "projectId is required" });
    }
    if (!amount || amount <= 0) {
      return res.status(400).json({ error: "amount must be positive" });
    }
    if (!intervalLedgers || intervalLedgers < MIN_INTERVAL_LEDGERS) {
      return res.status(400).json({ error: `intervalLedgers must be at least ${MIN_INTERVAL_LEDGERS}` });
    }
    if (!maxPayments || maxPayments > MAX_PAYMENTS) {
      return res.status(400).json({ error: `maxPayments must be at most ${MAX_PAYMENTS}` });
    }

    const amountStroops = Math.floor(Number(amount) * STROOP);

    if (signedXDR) {
      // Donor signed the XDR on the client side; submit to Soroban RPC
      if (!CONTRACT_ID) {
        return res.status(500).json({ error: "CONTRACT_ID not configured" });
      }

      try {
        const tx = TransactionBuilder.fromXDR(signedXDR, NETWORK_PASSPHRASE);
        const result = await rpcServer.sendTransaction(tx);
        const { status } = await rpcServer.getTransaction(result.hash);

        if (status !== "SUCCESS") {
          return res.status(500).json({ error: `Transaction failed: ${status}` });
        }

        // Retrieve the subscription ID from the result
        const txResult = await rpcServer.getTransaction(result.hash);
        let subscriptionId = null;
        if (txResult.returnValue) {
          subscriptionId = Number(txResult.returnValue);
        }

        // Store in Postgres
        const nextPaymentLedger = txResult.ledger ? txResult.ledger + intervalLedgers : 0;
        const insertResult = await pool.query(
          `INSERT INTO recurring_donations (subscription_id, donor_address, project_id, amount_stroops, interval_ledgers, next_payment_ledger, remaining_payments, active, created_at_ledger)
           VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, $8)
           ON CONFLICT (subscription_id) DO NOTHING
           RETURNING id`,
          [
            subscriptionId || 0,
            donorAddress,
            projectId,
            amountStroops.toString(),
            intervalLedgers,
            nextPaymentLedger,
            maxPayments,
            txResult.ledger || 0,
          ],
        );

        return res.status(201).json({
          success: true,
          data: {
            subscriptionId: subscriptionId || 0,
            donorAddress,
            projectId,
            amountStroops,
          },
        });
      } catch (err) {
        logger.error({ event: "subscription_submit_failed", err: err.message });
        return res.status(500).json({ error: `Failed to submit subscription: ${err.message}` });
      }
    } else {
      // Return the XDR for the donor to sign
      if (!CONTRACT_ID) {
        return res.status(500).json({ error: "CONTRACT_ID not configured" });
      }

      const amountArg = nativeToScVal(amountStroops, { type: "i128" });
      const intervalArg = nativeToScVal(intervalLedgers, { type: "u32" });
      const maxPaymentsArg = nativeToScVal(maxPayments, { type: "u32" });
      const projIdArg = nativeToScVal(projectId, { type: "string" });
      const donorArg = nativeToScVal(donorAddress, { type: "address" });

      const contract = new Contract(CONTRACT_ID);
      const { sequence } = await rpcServer.getAccount(donorAddress);

      const tx = new TransactionBuilder(
        { publicKey: donorAddress, sequence: sequence.toString() },
        { fee: BASE_FEE, networkPassphrase: NETWORK_PASSPHRASE },
      )
        .addOperation(contract.call("create_subscription", donorArg, projIdArg, amountArg, intervalArg, maxPaymentsArg))
        .setTimeout(300)
        .build();

      return res.json({
        success: true,
        data: {
          xdr: tx.toXDR(),
          networkPassphrase: NETWORK_PASSPHRASE,
        },
      });
    }
  } catch (e) {
    next(e);
  }
});

// GET /api/recurring-donations/:donorAddress
// List all recurring donations for a donor.
router.get("/:donorAddress", async (req, res, next) => {
  try {
    const { donorAddress } = req.params;

    if (!donorAddress || typeof donorAddress !== "string") {
      return res.status(400).json({ error: "donorAddress is required" });
    }

    const result = await pool.query(
      `SELECT * FROM recurring_donations WHERE donor_address = $1 ORDER BY created_at DESC`,
      [donorAddress],
    );

    res.json({ success: true, data: result.rows });
  } catch (e) {
    next(e);
  }
});

// DELETE /api/recurring-donations/:id
// Cancel a recurring donation (marks as inactive). The actual on-chain
// cancellation should be done by the donor calling cancel_subscription
// on the contract; this endpoint updates the DB to stop the cron from
// processing it.
router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const { donorAddress } = req.body;

    if (!donorAddress) {
      return res.status(400).json({ error: "donorAddress is required" });
    }

    const result = await pool.query(
      `UPDATE recurring_donations SET active = FALSE, updated_at = NOW()
       WHERE id = $1 AND donor_address = $2
       RETURNING *`,
      [id, donorAddress],
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Subscription not found" });
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
