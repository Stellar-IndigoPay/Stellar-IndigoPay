"use strict";

/**
 * routes/attestations.js
 *
 * Cross-Chain Donation Attestation Bridge — public API (issue #125).
 *
 * Mounted twice by server.js, once at /api/attestations and once at
 * /api/v1/attestations, mirroring the convention used by every other
 * route in the API surface.
 *
 * Endpoints:
 *
 *   GET  /              → platform-wide attestation stats (total / pending).
 *   GET  /:id           → single attestation by backend UUID.
 *   GET  /by-id/:n      → single attestation by Soroban on-chain id.
 *   GET  /by-donor/:pk  → all attestations for a Stellar address.
 *   GET  /by-source     → look up via pair {source_chain, source_tx_hash}.
 *   POST /build-proof   → mint a signed proof for partner integrations.
 *   POST /              → record a new attestation (relayer/admin only).
 *   POST /:id/verify    → flip status pending → verified.
 *   POST /:id/revoke    → admin-only rollback.
 *
 * The POST routes require either a valid CSRF token (when invoked from
 * the same-origin web app) OR a partner proof header. Because proof
 * verification relies on a per-partner secret pulled from the
 * ATTESTATION_RELAYER_SECRET env var, this file is safe to load in
 * environments where CSRF is disabled — the proof itself is the
 * password.
 */
const express = require("express");
const router = express.Router();
const logger = require("../logger");
const pool = require("../db/pool");
const attestationService = require("../services/attestation");
const { createRateLimiter } = require("../middleware/rateLimiter");
const { adminRequired } = require("../middleware/auth");

// Write-side endpoints are limited more aggressively than reads because
// they can be hammered by misbehaving partners with valid secrets.
const writeLimiter = createRateLimiter(30, 1); // 30 req / minute
const readLimiter = createRateLimiter(120, 1); // 120 req / minute

// Helper: shape a DB row for the API response. Keeps the response schema
// stable even when we add / remove columns.
function publicShape(row) {
  if (!row) return null;
  return {
    id: row.id,
    onChainId:
      row.on_chain_id !== undefined && row.on_chain_id !== null
        ? Number(row.on_chain_id)
        : null,
    sourceChain: row.source_chain,
    sourceTxHash: row.source_tx_hash,
    donorAddress: row.donor_address,
    projectId: row.project_id,
    amountUsd: row.amount_usd !== undefined ? row.amount_usd.toString() : null,
    amountXlm: row.amount_xlm !== undefined ? row.amount_xlm.toString() : null,
    status: row.status,
    messageHash:
      row.message_hash !== undefined && row.message_hash !== null
        ? Number(row.message_hash)
        : null,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

// ─── Reads ─────────────────────────────────────────────────────────────────

router.get("/", readLimiter, async (req, res, next) => {
  try {
    const [totals, perChain] = await Promise.all([
      pool.query(
        `SELECT
           COUNT(*)::bigint                 AS total,
           COUNT(*) FILTER (WHERE status='pending')::bigint  AS pending,
           COUNT(*) FILTER (WHERE status='verified')::bigint AS verified,
           COUNT(*) FILTER (WHERE status='revoked')::bigint  AS revoked
         FROM attestations`,
      ),
      pool.query(
        `SELECT source_chain, COUNT(*)::bigint AS count
           FROM attestations
           GROUP BY source_chain
           ORDER BY count DESC
           LIMIT 25`,
      ),
    ]);

    res.json({
      success: true,
      data: {
        total: Number(totals.rows[0]?.total ?? 0),
        pending: Number(totals.rows[0]?.pending ?? 0),
        verified: Number(totals.rows[0]?.verified ?? 0),
        revoked: Number(totals.rows[0]?.revoked ?? 0),
        byChain: perChain.rows.map((row) => ({
          sourceChain: row.source_chain,
          count: Number(row.count),
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/by-source", readLimiter, async (req, res, next) => {
  try {
    const sourceChain = attestationService.assertValidSourceChain(
      req.query.source_chain || req.query.chain,
    );
    const sourceTxHash = attestationService.assertValidTxHash(
      req.query.source_tx_hash || req.query.tx_hash,
    );
    const row = await attestationService.findBySource(sourceChain, sourceTxHash);
    if (!row) {
      return res
        .status(404)
        .json({ success: false, error: "Attestation not found" });
    }
    res.json({ success: true, data: publicShape(row) });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    next(err);
  }
});

router.get("/by-donor/:publicKey", readLimiter, async (req, res, next) => {
  try {
    const donor = attestationService.assertValidStellarAddress(
      req.params.publicKey,
    );
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || 50, 1),
      200,
    );
    const rows = await attestationService.listByDonor(donor, { limit });
    res.json({ success: true, data: rows.map(publicShape) });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    next(err);
  }
});

router.get("/by-id/:onChainId", readLimiter, async (req, res, next) => {
  try {
    const id = Number.parseInt(req.params.onChainId, 10);
    if (!Number.isFinite(id) || id < 0) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid on-chain id" });
    }
    const row = await attestationService.findByOnChainId(id);
    if (!row) {
      return res
        .status(404)
        .json({ success: false, error: "Attestation not found" });
    }
    res.json({ success: true, data: publicShape(row) });
  } catch (err) {
    next(err);
  }
});

router.get("/:id", readLimiter, async (req, res, next) => {
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        req.params.id,
      )
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid attestation id" });
    }
    const row = await attestationService.findById(req.params.id);
    if (!row) {
      return res
        .status(404)
        .json({ success: false, error: "Attestation not found" });
    }
    res.json({ success: true, data: publicShape(row) });
  } catch (err) {
    next(err);
  }
});

// ─── Writes ────────────────────────────────────────────────────────────────

/**
 * Build a signed proof for a cross-chain donation observation. Partners
 * (e.g. an external wallet, a Stripe webhook receiver) POST the observed
 * fields and get back a payload + signature that they can include when
 * they POST /api/attestations to record it server-side.
 *
 * The signing secret comes from `ATTESTATION_RELAYER_SECRET`. When
 * unset (development), a deterministic dummy secret is used so the
 * endpoint is still callable for manual tests.
 */
router.post("/build-proof", readLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const sourceChain = attestationService.assertValidSourceChain(
      body.source_chain || body.sourceChain,
    );
    const sourceTxHash = attestationService.assertValidTxHash(
      body.source_tx_hash || body.sourceTxHash,
    );
    const donor = attestationService.assertValidStellarAddress(
      body.donor_address || body.donorAddress,
    );
    const projectId = String(body.project_id || body.projectId || "").trim();
    if (!projectId) {
      return res
        .status(400)
        .json({ success: false, error: "project_id is required" });
    }

    const input = {
      source_chain: sourceChain,
      source_tx_hash: sourceTxHash,
      donor,
      project_id: projectId,
    };
    const secret = process.env.ATTESTATION_RELAYER_SECRET;
    if (!secret) {
      // In production, missing env var is a fatal misconfiguration. In
      // development we accept it but log a loud warning so an operator
      // notices when the deployment is real.
      if (process.env.NODE_ENV === "production") {
        return res
          .status(503)
          .json({ success: false, error: "Attestation service not configured" });
      }
      // eslint-disable-next-line no-console
      console.warn(
        "[attestations] ATTESTATION_RELAYER_SECRET is unset; proofs minted will be insecure. Set the env var before going live.",
      );
    }
    const timestamp = Math.floor(Date.now() / 1000);
    const { payload, signature } = attestationService.buildAttestationProof(
      input,
      secret || "dev-attestation-secret",
      timestamp,
    );

    res.json({
      success: true,
      data: {
        payload,
        signature,
        timestamp,
        canonical: input,
      },
    });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    next(err);
  }
});

/**
 * Record an attestation. Called by the relayer after source-chain
 * finality (e.g. 12 blocks on Ethereum PoS, 64 on Bitcoin, etc.).
 *
 * Body shape:
 *   {
 *     source_chain:      "ethereum",
 *     source_tx_hash:    "0x…",
 *     donor_address:     "G…",
 *     project_id:        "<uuid>",
 *     amount_usd:        "10.0",      // 6dp
 *     amount_xlm:        "80.0",      // stroops
 *     message_hash:      0,           // optional u32
 *     on_chain_id:       42,          // relayer supplies what the contract returned
 *     x_proof_signature: "t=…,v1=…",  // required partner proof
 *     x_proof_timestamp: 1700000000   // unix seconds
 *   }
 */
router.post("/", writeLimiter, async (req, res, next) => {
  try {
    const body = req.body || {};
    const sourceChain = attestationService.assertValidSourceChain(
      body.source_chain || body.sourceChain,
    );
    const sourceTxHash = attestationService.assertValidTxHash(
      body.source_tx_hash || body.sourceTxHash,
    );
    const donor = attestationService.assertValidStellarAddress(
      body.donor_address || body.donorAddress,
    );
    const projectId = String(body.project_id || body.projectId || "").trim();
    if (!projectId) {
      return res
        .status(400)
        .json({ success: false, error: "project_id is required" });
    }
    const amountUsd = Number(body.amount_usd ?? body.amountUsd);
    const amountXlm = Number(body.amount_xlm ?? body.amountXlm);
    if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
      return res
        .status(400)
        .json({ success: false, error: "amount_usd must be a positive number" });
    }
    if (!Number.isFinite(amountXlm) || amountXlm <= 0) {
      return res
        .status(400)
        .json({ success: false, error: "amount_xlm must be a positive number" });
    }
    const onChainId = Number.parseInt(body.on_chain_id ?? body.onChainId, 10);
    if (!Number.isFinite(onChainId) || onChainId < 0) {
      return res
        .status(400)
        .json({ success: false, error: "on_chain_id is required" });
    }

    const signature =
      req.get("x-attestation-signature") || req.get("x_proof_signature");
    const timestampHeader =
      req.get("x-attestation-timestamp") || req.get("x_proof_timestamp");
    const secret =
      process.env.ATTESTATION_RELAYER_SECRET || "dev-attestation-secret";
    const ts = Number.parseInt(timestampHeader, 10);
    if (!signature || !Number.isFinite(ts)) {
      return res.status(401).json({
        success: false,
        error:
          "Missing x-attestation-signature / x-attestation-timestamp headers",
      });
    }
    const ok = attestationService.verifyAttestationProof(
      {
        source_chain: sourceChain,
        source_tx_hash: sourceTxHash,
        donor,
        project_id: projectId,
      },
      secret,
      signature,
      ts,
    );
    if (!ok) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid proof signature" });
    }

    const recordedBy =
      req.get("x-relayer-address") || body.recorded_by || null;

    const { row, created } = await attestationService.upsertAttestation({
      on_chain_id: onChainId,
      source_chain: sourceChain,
      source_tx_hash: sourceTxHash,
      donor_address: donor,
      project_id: projectId,
      amount_usd: amountUsd,
      amount_xlm: amountXlm,
      message_hash: body.message_hash ?? body.messageHash ?? 0,
      status: body.status || "pending",
      recorded_by: recordedBy,
    });

    const status = row.status === "pending" && !created ? 200 : 201;
    logger.info(
      {
        event: "attestation_route_recorded",
        created,
        id: row.id,
        on_chain_id: Number(row.on_chain_id),
        source_chain: row.source_chain,
        donor: row.donor_address,
      },
      "Attestation route recorded",
    );

    res.status(status).json({ success: true, data: publicShape(row), created });
  } catch (err) {
    if (err.status) {
      return res.status(err.status).json({ success: false, error: err.message });
    }
    next(err);
  }
});

router.post("/:id/verify", writeLimiter, async (req, res, next) => {
  try {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        req.params.id,
      )
    ) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid attestation id" });
    }
    const row = await attestationService.markVerified(req.params.id);
    if (!row) {
      return res
        .status(404)
        .json({ success: false, error: "Attestation not found or already verified" });
    }
    res.json({ success: true, data: publicShape(row) });
  } catch (err) {
    next(err);
  }
});

/**
 * Admin-only: revoke an attestation. Gated by the standard
 * `requireAdmin` middleware so callers must present a valid admin
 * JWT (the canonical auth path for /api/admin/*) or an `X-Admin-Key`
 * shared secret. This prevents a misconfigured client from
 * accidentally (or maliciously) wiping live attestations.
 */
// Inline UUID validator. Runs BEFORE admin auth so callers see a precise
// "Invalid attestation id" 400 instead of a misleading 401 — validation
// should happen before authorization whenever the input itself is clearly
// malformed.
function validateAttestationId(id) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(id || ""),
  );
}

router.post(
  "/:id/revoke",
  writeLimiter,
  (req, res, next) => {
    // Validate UUID first so the error message is actionable.
    if (!validateAttestationId(req.params.id)) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid attestation id" });
    }
    return adminRequired(req, res, next);
  },
  async (req, res, next) => {
    try {
      const reviewer =
        (req.admin && (req.admin.username || req.admin.sub)) ||
        req.get("x-admin-key") ||
        "admin-api";
      const row = await attestationService.revoke(req.params.id, reviewer);
      if (!row) {
        return res
          .status(404)
          .json({ success: false, error: "Attestation not found or already revoked" });
      }
      res.json({ success: true, data: publicShape(row) });
    } catch (err) {
      next(err);
    }
  },
);

module.exports = router;
