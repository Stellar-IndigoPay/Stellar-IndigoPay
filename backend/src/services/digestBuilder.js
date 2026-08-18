"use strict";

const crypto = require("crypto");
const pool = require("../db/pool");
const logger = require("../logger");

const UNSUBSCRIBE_SECRET =
  process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || "";
const DIGEST_CHANNEL = "email";
const DIGEST_TYPE = "digest";
const DIGEST_TOKEN_VERSION = 1;
const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const DIGEST_TYPES = {
  daily: "daily",
  weekly: "weekly",
};

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
}

function getDigestWindow(type, now = new Date()) {
  const utcNow = new Date(now.toISOString());
  const end = new Date(
    Date.UTC(
      utcNow.getUTCFullYear(),
      utcNow.getUTCMonth(),
      utcNow.getUTCDate(),
    ),
  );

  if (type === DIGEST_TYPES.daily) {
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 1);
    return {
      start,
      end,
      label: `Daily Digest — ${formatDate(start)}`,
    };
  }

  if (type === DIGEST_TYPES.weekly) {
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 7);
    const endDay = new Date(end);
    endDay.setUTCDate(endDay.getUTCDate() - 1);
    return {
      start,
      end,
      label: `Weekly Digest — ${formatDate(start)} to ${formatDate(endDay)}`,
    };
  }

  throw new Error(`Unsupported digest type: ${type}`);
}

function base64UrlEncode(data) {
  return Buffer.from(data)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(encoded) {
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  return Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signPayload(payload) {
  if (!UNSUBSCRIBE_SECRET) {
    throw new Error("UNSUBSCRIBE_SECRET is not configured");
  }
  const hmac = crypto.createHmac("sha256", UNSUBSCRIBE_SECRET);
  hmac.update(payload);
  return hmac.digest("hex");
}

function generateUnsubscribeToken({ walletAddress, type = DIGEST_TYPE }) {
  if (!walletAddress) {
    throw new Error("walletAddress is required for unsubscribe token generation");
  }
  const payload = {
    v: DIGEST_TOKEN_VERSION,
    walletAddress,
    type,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };

  const serialized = JSON.stringify(payload);
  const signature = signPayload(serialized);
  return `${base64UrlEncode(serialized)}.${signature}`;
}

function verifyUnsubscribeToken(token) {
  if (!token || typeof token !== "string") {
    const err = new Error("Missing unsubscribe token");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  const parts = token.split(".");
  if (parts.length !== 2) {
    const err = new Error("Malformed unsubscribe token");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  let payloadJson;
  try {
    payloadJson = base64UrlDecode(parts[0]).toString("utf8");
  } catch (err) {
    const decodeErr = new Error("Malformed unsubscribe token");
    decodeErr.code = "INVALID_TOKEN";
    throw decodeErr;
  }

  const expectedSignature = signPayload(payloadJson);
  const suppliedSignature = parts[1];
  const expectedBuffer = Buffer.from(expectedSignature, "hex");
  const suppliedBuffer = Buffer.from(suppliedSignature, "hex");

  if (
    expectedBuffer.length !== suppliedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, suppliedBuffer)
  ) {
    const err = new Error("Invalid unsubscribe token signature");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  let payload;
  try {
    payload = JSON.parse(payloadJson);
  } catch (err) {
    const parseErr = new Error("Invalid unsubscribe token payload");
    parseErr.code = "INVALID_TOKEN";
    throw parseErr;
  }

  if (payload.v !== DIGEST_TOKEN_VERSION) {
    const err = new Error("Unsupported unsubscribe token version");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  if (!payload.walletAddress || payload.type !== DIGEST_TYPE) {
    const err = new Error("Invalid unsubscribe token payload");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) {
    const err = new Error("Unsubscribe token expired");
    err.code = "INVALID_TOKEN";
    throw err;
  }

  return { walletAddress: payload.walletAddress, type: payload.type };
}

async function buildDigests(type, now = new Date()) {
  if (!Object.values(DIGEST_TYPES).includes(type)) {
    throw new Error(`Unsupported digest type: ${type}`);
  }

  const window = getDigestWindow(type, now);
  const { start, end, label } = window;

  const summaryResult = await pool.query(
    `WITH donor_emails AS (
       SELECT donor_address, MIN(email) AS email
       FROM project_subscriptions
       WHERE donor_address IS NOT NULL
       GROUP BY donor_address
     ), preferences AS (
       SELECT wallet_address,
              bool_or(CASE WHEN type = 'digest' THEN enabled END) AS digest_enabled,
              bool_or(CASE WHEN type IS NULL THEN enabled END) AS blanket_enabled
       FROM notification_preferences
       WHERE channel = $3
       GROUP BY wallet_address
     )
     SELECT d.donor_address,
            de.email,
            SUM(d.amount_xlm)::numeric(20,7) AS total_donated_xlm,
            COUNT(*)::int AS donation_count,
            COUNT(DISTINCT d.project_id)::int AS projects_supported,
            ROUND(
              SUM(
                CASE
                  WHEN p.raised_xlm > 0
                    THEN d.amount_xlm * (p.co2_offset_kg::numeric / p.raised_xlm)
                  ELSE 0
                END
              )::numeric,
              4
            ) AS total_co2_kg,
            ARRAY_AGG(DISTINCT p.name) AS project_names
     FROM donations d
     JOIN donor_emails de ON de.donor_address = d.donor_address
     JOIN projects p ON p.id = d.project_id
     LEFT JOIN preferences np ON np.wallet_address = d.donor_address
     WHERE d.created_at >= $1
       AND d.created_at < $2
       AND COALESCE(np.digest_enabled, np.blanket_enabled, TRUE) = TRUE
       AND d.amount_xlm IS NOT NULL
     GROUP BY d.donor_address, de.email
     HAVING SUM(d.amount_xlm) > 0
     ORDER BY de.email ASC`,
    [start.toISOString(), end.toISOString(), DIGEST_CHANNEL],
  );

  const digests = (summaryResult.rows || []).map((row) => ({
    donorAddress: row.donor_address,
    email: row.email,
    totalDonatedXLM: Number(row.total_donated_xlm || 0),
    donationCount: Number(row.donation_count || 0),
    projectsSupported: Number(row.projects_supported || 0),
    co2OffsetKg: Number(row.total_co2_kg || 0),
    projectNames: Array.isArray(row.project_names)
      ? row.project_names.filter(Boolean)
      : [],
    unsubscribeToken: generateUnsubscribeToken({
      walletAddress: row.donor_address,
    }),
    recentDonations: [],
  }));

  if (digests.length === 0) {
    logger.info(
      { event: "digest_builder_no_results", digestType: type, label },
      "No digest recipients found for period",
    );
    return { type, label, digests };
  }

  const donorAddresses = digests.map((digest) => digest.donorAddress);
  const donationsResult = await pool.query(
    `SELECT d.donor_address,
            d.amount_xlm,
            d.currency,
            d.created_at,
            p.name AS project_name,
            ROUND(
              CASE
                WHEN p.raised_xlm > 0
                  THEN d.amount_xlm * (p.co2_offset_kg::numeric / p.raised_xlm)
                ELSE 0
              END,
              4
            ) AS co2_kg
     FROM donations d
     JOIN projects p ON p.id = d.project_id
     WHERE d.created_at >= $1
       AND d.created_at < $2
       AND d.donor_address = ANY($3::text[])
     ORDER BY d.donor_address ASC, d.created_at DESC`,
    [start.toISOString(), end.toISOString(), donorAddresses],
  );

  const donationsByDonor = new Map();
  for (const row of donationsResult.rows) {
    if (!donationsByDonor.has(row.donor_address)) {
      donationsByDonor.set(row.donor_address, []);
    }
    const queue = donationsByDonor.get(row.donor_address);
    if (queue.length < 5) {
      queue.push({
        projectName: row.project_name,
        amountXLM: Number(row.amount_xlm || 0),
        currency: row.currency,
        createdAt: row.created_at,
        co2OffsetKg: Number(row.co2_kg || 0),
      });
    }
  }

  for (const digest of digests) {
    digest.recentDonations = donationsByDonor.get(digest.donorAddress) || [];
  }

  logger.info(
    { event: "digest_builder_generated", digestType: type, count: digests.length },
    "Built digest payloads",
  );

  return { type, label, digests };
}

module.exports = {
  buildDigests,
  generateUnsubscribeToken,
  verifyUnsubscribeToken,
  DIGEST_TYPES,
};
