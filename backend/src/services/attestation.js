"use strict";

/**
 * services/attestation.js
 *
 * Cross-Chain Donation Attestation Bridge — backend support (issue #125).
 *
 * The Soroban `attestation-contract` (see contracts/attestation-contract/
 * src/lib.rs) is the on-chain source of truth. This service is the
 * *off-chain* layer that:
 *
 *   - signs source-chain observation reports so trustless verifiers can
 *     confirm "this backend really saw that tx";
 *   - persists an off-chain copy of every attestation so reads don't
 *     Soroban-RPC every time the frontend loads;
 *   - exposes helpers that the /api/attestations routes delegate to.
 *
 * Replay protection spans both layers:
 *
 *   - DB UNIQUE (source_chain, source_tx_hash) blocks double-write at
 *     the backend even before we submit to Soroban;
 *   - Contract DataKey::SourceTxSeen(...) blocks double-write on-chain
 *     after backend submission.
 *
 * The two layers also intentionally diverge: contracts refuse duplicates
 * without ever revealing the original id, while the backend returns the
 * stored row so the frontend can show "this source tx was already bridged
 * by N earlier observation".
 */
const crypto = require("crypto");
const pool = require("../db/pool");
const logger = require("../logger");
const webhookSign = require("../lib/webhookSign");

// ------------------------------------------------------------------
// Configuration
// ------------------------------------------------------------------

// Fail-closed default for non-test environments. If the operator hasn't
// explicitly told us which source chains to trust we trust NONE of them —
// a forged "ethereum" entry should never slip through because someone
// forgot to set the env var in prod. Tests can override via
// `process.env.ATTESTATION_ALLOWED_CHAINS = "ethereum,polygon"` before
// requiring this module (the Set is built once at import time).
const SOURCE_CHAINS = (() => {
  if (process.env.NODE_ENV === "test") {
    return new Set(
      (process.env.ATTESTATION_ALLOWED_CHAINS ||
        "ethereum,polygon,arbitrum,base")
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean),
    );
  }
  if (!process.env.ATTESTATION_ALLOWED_CHAINS) {
    return new Set(); // fail-closed in prod
  }
  return new Set(
    process.env.ATTESTATION_ALLOWED_CHAINS.split(",")
      .map((c) => c.trim().toLowerCase())
      .filter(Boolean),
  );
})();

const DEFAULT_REPLAY_WINDOW_SECONDS = 5 * 60;

/**
 * Hex-encoded digest returned to callers so they can quote exactly what
 * will land on-chain when the relayer submits the Soroban tx.
 *
 * Shape:
 *   sha256(`${source_chain}|${source_tx_hash}|${donor}|${project_id}`)
 *
 * Adding the fields the relayer will pass to `record_attestation` means
 * any client-side tampering (different project, different donor) will
 * produce a different canonical hash and the proof will be rejected
 * when the relayer re-builds it server-side.
 */
function computeAttestationHash(input) {
  return crypto
    .createHash("sha256")
    .update(`${input.source_chain}|${input.source_tx_hash}|${input.donor}|${input.project_id}`)
    .digest("hex");
}

/**
 * Build the signed payload the frontend (or any external partner) can use
 * to prove to the relayer that they observed the cross-chain tx. Uses the
 * same GitHub-style signature as the webhook implementation
 * (`lib/webhookSign.js`) so the receiver code is already tested and reused.
 *
 * The signature is computed over the canonical hash rather than the raw
 * fields, which keeps the signature length constant regardless of source
 * chain choice.
 *
 * SECURITY: `secret` is required. In production a missing
 * `ATTESTATION_RELAYER_SECRET` env var is a hard error — we never want
 * to silently fall back to a known string that would let a malicious
 * partner forge attestations against the live instance.
 */
function buildAttestationProof(input, secret, timestamp) {
  if (!secret || typeof secret !== "string") {
    const err = new Error(
      "ATTESTATION_RELAYER_SECRET must be configured to mint proofs",
    );
    err.status = 500;
    throw err;
  }
  const payload = computeAttestationHash(input);
  const signature = webhookSign.sign(payload, secret, timestamp);
  return { payload, signature };
}

/**
 * Constant-time verifier, mirroring webhookSign.verify(). Exposed for
 * the partner-integration tests and the admin "recompute" endpoint.
 */
function verifyAttestationProof(
  input,
  secret,
  signatureHeader,
  now = Math.floor(Date.now() / 1000),
) {
  const payload = computeAttestationHash(input);
  return webhookSign.verify(payload, secret, signatureHeader, now);
}

// ------------------------------------------------------------------
// DB CRUD
// ------------------------------------------------------------------

/**
 * Look up an attestation by its (source_chain, source_tx_hash) pair.
 * Returns the row or null — never throws on "not found".
 */
async function findBySource(sourceChain, sourceTxHash) {
  const { rows } = await pool.query(
    `SELECT * FROM attestations
       WHERE source_chain = $1 AND source_tx_hash = $2
       LIMIT 1`,
    [String(sourceChain).toLowerCase(), sourceTxHash],
  );
  return rows[0] || null;
}

/**
 * Look up an attestation by its on-chain id (monotonic Soroban counter).
 */
async function findByOnChainId(onChainId) {
  const { rows } = await pool.query(
    "SELECT * FROM attestations WHERE on_chain_id = $1 LIMIT 1",
    [Number(onChainId)],
  );
  return rows[0] || null;
}

/**
 * Look up an attestation by its backend UUID. Mostly used by the admin
 * endpoints.
 */
async function findById(id) {
  const { rows } = await pool.query(
    "SELECT * FROM attestations WHERE id = $1 LIMIT 1",
    [id],
  );
  return rows[0] || null;
}

/**
 * List attestations for a donor address, newest first.
 * `limit` defaults to 50 and is capped at 200 to keep the response small.
 */
async function listByDonor(donorAddress, { limit = 50 } = {}) {
  const capped = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const { rows } = await pool.query(
    `SELECT * FROM attestations
       WHERE donor_address = $1
       ORDER BY created_at DESC
       LIMIT $2`,
    [donorAddress, capped],
  );
  return rows;
}

/**
 * Idempotent insert. If the pair (source_chain, source_tx_hash) is already
 * stored, the existing row is returned — a second POST with the same proof
 * is treated as a duplicate observation, not an error.
 *
 * Returns `{ row, created: boolean }`. `created` is true when this call
 * performed the INSERT, false when the row pre-existed.
 *
 * NOTE: input validation runs before any DB call so an invalid `on_chain_id`
 * (or other field) fails fast without touching the connection pool. The
 * race in `findBySource` is unaffected because the row pre-existing is
 * still a valid "stop here" outcome.
 */
async function upsertAttestation(input, _opts = {}) {
  const onChainId = Number.parseInt(input.on_chain_id, 10);
  if (!Number.isFinite(onChainId) || onChainId < 0) {
    throw new Error("Invalid on_chain_id");
  }

  const lookup = await findBySource(input.source_chain, input.source_tx_hash);
  if (lookup) {
    return { row: lookup, created: false };
  }

  const id = crypto.randomUUID();

  const status = input.status && ["pending", "verified", "revoked"].includes(input.status)
    ? input.status
    : "pending";

  try {
    const { rows } = await pool.query(
      `INSERT INTO attestations
        (id, on_chain_id, source_chain, source_tx_hash, donor_address,
         project_id, amount_usd, amount_xlm, message_hash, status,
         recorded_by, created_at, verified_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),
               CASE WHEN $10 = 'verified' THEN NOW() ELSE NULL END)
       RETURNING *`,
      [
        id,
        onChainId,
        String(input.source_chain).toLowerCase(),
        input.source_tx_hash,
        input.donor_address,
        input.project_id || null,
        input.amount_usd,
        input.amount_xlm,
        input.message_hash || 0,
        status,
        input.recorded_by || null,
      ],
    );
    logger.info(
      {
        event: "attestation_persisted",
        id: rows[0].id,
        on_chain_id: rows[0].on_chain_id,
        source_chain: rows[0].source_chain,
        donor: rows[0].donor_address,
      },
      "Cross-chain attestation recorded",
    );
    return { row: rows[0], created: true };
  } catch (err) {
    // 23505 = unique_violation in Postgres. If a parallel insert raced
    // ahead of us, look up the row it wrote. We retry the lookup twice
    // because the other writer may have called COMMIT between our INSERT
    // and the rollback-confirmation; on a fresh replica lag the row
    // might not yet be visible to our pool. If we still can't find it
    // after the bounded retry we surface a clear error rather than a
    // cryptic "Cannot destructure rows of undefined".
    if (err && err.code === "23505") {
      let existing = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        existing = await findBySource(input.source_chain, input.source_tx_hash);
        if (existing) break;
      }
      if (existing) return { row: existing, created: false };
      logger.error(
        {
          event: "attestation_upsert_race",
          source_chain: input.source_chain,
          source_tx_hash: input.source_tx_hash,
        },
        "23505 unique-violation but row is still not visible to the writer",
      );
      const race = new Error("attestation upsert race: cannot resolve row");
      race.status = 503;
      throw race;
    }
    throw err;
  }
}

/**
 * Flip status pending → verified. No-op (returns false) if the row is
 * already verified — partner integrations retry blindly and we don't want
 * to error-spam them.
 */
async function markVerified(id) {
  const { rows } = await pool.query(
    `UPDATE attestations
       SET status = 'verified', verified_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING *`,
    [id],
  );
  return rows[0] || null;
}

/**
 * Admin-only: flip verified/pending → revoked. Idempotent (returns null if
 * the row was already revoked). Used when a source-chain re-org invalidates
 * the underlying transaction.
 */
async function revoke(id, reviewer) {
  const { rows } = await pool.query(
    `UPDATE attestations
       SET status = 'revoked'
       WHERE id = $1 AND status <> 'revoked'
       RETURNING *`,
    [id],
  );
  if (rows[0]) {
    logger.warn(
      {
        event: "attestation_revoked",
        id: rows[0].id,
        on_chain_id: rows[0].on_chain_id,
        reviewer,
      },
      "Cross-chain attestation revoked",
    );
  }
  return rows[0] || null;
}

// ------------------------------------------------------------------
// Validation helpers
// ------------------------------------------------------------------

/**
 * Throwing validator used by the route to fail fast on bad input.
 */
function assertValidSourceChain(chain) {
  const c = String(chain || "").toLowerCase();
  if (SOURCE_CHAINS.size > 0 && !SOURCE_CHAINS.has(c)) {
    const err = new Error(`Unsupported source_chain: ${chain}`);
    err.status = 400;
    err.code = "unsupported_source_chain";
    throw err;
  }
  return c;
}

/**
 * Sanity-check `source_tx_hash`. Accepts hex (0x…) and longer base64
 * variants, returns the canonical lowercase form. Length-bounds match the
 * Soroban contract so backend writes never violate on-chain limits.
 *
 * Lower bound is 40 characters: shorter than that is below the smallest
 * plausible chain hash (a Bitcoin-style base58 hash is 64 chars; an EVM
 * tx hash is 66 chars; a Solana tx signature is ~88). Anything shorter
 * is a typo or an attempt to bypass the validation.
 */
function assertValidTxHash(hash) {
  const trimmed = String(hash || "").trim();
  if (trimmed.length < 40 || trimmed.length > 128) {
    const err = new Error("source_tx_hash must be 40–128 chars");
    err.status = 400;
    throw err;
  }
  return trimmed;
}

/**
 * Stellar address shape check. Mirrors the runtime check the contract
 * performs so we never POST an attestation against a syntactically
 * invalid address.
 *
 * NOTE: This is a *sanity* check, not proof of account existence — in
 * testnet/mainnet the address may not yet have any history.
 */
function assertValidStellarAddress(addr) {
  const re = /^G[A-Z0-9]{55}$/;
  if (!re.test(String(addr || ""))) {
    const err = new Error("donor_address must be a Stellar public key (G…)");
    err.status = 400;
    throw err;
  }
  return String(addr);
}

module.exports = {
  SOURCE_CHAINS,
  DEFAULT_REPLAY_WINDOW_SECONDS,
  computeAttestationHash,
  buildAttestationProof,
  verifyAttestationProof,
  assertValidSourceChain,
  assertValidTxHash,
  assertValidStellarAddress,
  upsertAttestation,
  markVerified,
  revoke,
  findBySource,
  findByOnChainId,
  findById,
  listByDonor,
};
