/**
 * src/services/co2Verifier.js — Automated CO₂ offset-rate verification
 *
 * Project owners self-report co2_per_xlm (kg of CO₂ offset per 1 XLM
 * donated) when they apply for verification. Nothing stops a malicious
 * applicant from claiming an absurd rate (the contract only caps it at
 * MAX_CO2_PER_XLM = 100,000), so this service sanity-checks every
 * submitted rate against per-category industry benchmarks and flags
 * outliers for admin review before the project's impact numbers are
 * trusted.
 *
 * Verdicts (stored in projects.co2_verification_status):
 *   - "verified" — rate is within 3× the category benchmark; plausible.
 *   - "review"   — rate is 3–10× the benchmark; above the typical range
 *                  and worth a closer look, but not necessarily bogus.
 *   - "flagged"  — rate is >10× the benchmark (or unparseable); requires
 *                  explicit admin resolution before it should be trusted.
 *
 * Two further statuses exist at the DB level but are never produced by
 * verifyCO2Rate():
 *   - "pending"  — column default; no verification has run yet.
 *   - "rejected" — an admin resolved a flag by rejecting the claimed rate.
 *
 * Public surface:
 *   - CATEGORY_BENCHMARKS            benchmark table (kg CO₂ per XLM)
 *   - CO2_VERIFICATION_STATUSES      every value the DB column may hold
 *   - REVIEW_MULTIPLIER / FLAG_MULTIPLIER   threshold constants
 *   - verifyCO2Rate(category, co2PerXLM)    pure benchmark comparison
 *   - applyCO2VerificationToProject(...)    runs verifyCO2Rate and stamps
 *       the verdict onto the matching projects row(s); called from the
 *       verification approval flow (routes/verification.js).
 */
"use strict";

const pool = require("../db/pool");
const logger = require("../logger");

/**
 * Industry benchmarks, in kg CO₂ offset per 1 XLM donated.
 *
 * Derivation: verified carbon-credit programmes (Gold Standard, Verra VCS)
 * price offsets at roughly $0.20–$2 per tonne for the cheapest projects,
 * i.e. ~0.5–5 kg CO₂ per $1 donated. At an assumed ~$1/XLM budgeting rate
 * that translates directly to kg-per-XLM figures:
 *
 *   - Reforestation (~2.5): tree planting averages ~$1 per 2–3 kg over the
 *     tree's lifetime (Eden Reforestation / One Tree Planted cost models).
 *   - Solar (~3.0) / Wind (~3.5): utility-scale renewables displace fossil
 *     generation at ~$0.30–0.40 per kg CO₂ avoided (IRENA LCOE data).
 *   - Carbon Capture (~4.0): industrial DAC + point-source capture credits
 *     currently clear at the top of the voluntary market range.
 *   - Ocean Conservation / Wildlife Protection (~1.5): habitat programmes
 *     sequester less per dollar; most spend goes to protection, not offset.
 *   - Clean Water (~1.0): primarily a health intervention; CO₂ benefit is a
 *     side effect (e.g. less water boiling over wood fires).
 *   - Sustainable Agriculture (~2.0): soil-carbon / no-till credit pricing.
 *   - Other (~2.0): conservative mid-range default for unknown categories.
 *
 * max_reasonable is 10× the typical rate — the hard "flagged" boundary.
 * These are intentionally static for the initial version (see issue #104,
 * dynamic benchmark updates are out of scope).
 */
const CATEGORY_BENCHMARKS = {
  Reforestation: { co2_per_xlm_typical: 2.5, max_reasonable: 25 },
  "Solar Energy": { co2_per_xlm_typical: 3.0, max_reasonable: 30 },
  "Ocean Conservation": { co2_per_xlm_typical: 1.5, max_reasonable: 15 },
  "Clean Water": { co2_per_xlm_typical: 1.0, max_reasonable: 10 },
  "Wildlife Protection": { co2_per_xlm_typical: 1.5, max_reasonable: 15 },
  "Carbon Capture": { co2_per_xlm_typical: 4.0, max_reasonable: 40 },
  "Wind Energy": { co2_per_xlm_typical: 3.5, max_reasonable: 35 },
  "Sustainable Agriculture": { co2_per_xlm_typical: 2.0, max_reasonable: 20 },
  Other: { co2_per_xlm_typical: 2.0, max_reasonable: 20 },
};

// Rates above REVIEW_MULTIPLIER× the benchmark are marked "review";
// above FLAG_MULTIPLIER× they are "flagged" and require admin resolution.
const REVIEW_MULTIPLIER = 3;
const FLAG_MULTIPLIER = 10;

const CO2_VERIFICATION_STATUSES = [
  "pending",
  "verified",
  "review",
  "flagged",
  "rejected",
];

/**
 * Compare a submitted CO₂ offset rate against the category benchmark.
 *
 * @param {string} category - Project category (falls back to "Other").
 * @param {number|string} co2PerXLM - Claimed kg CO₂ offset per 1 XLM.
 * @returns {{status: "verified"|"review"|"flagged", reason: string|null,
 *            multiplier: number|null, benchmark: {category: string,
 *            co2PerXlmTypical: number, maxReasonable: number}}}
 */
function verifyCO2Rate(category, co2PerXLM) {
  const benchmarkCategory = Object.prototype.hasOwnProperty.call(
    CATEGORY_BENCHMARKS,
    category,
  )
    ? category
    : "Other";
  const benchmark = CATEGORY_BENCHMARKS[benchmarkCategory];
  const benchmarkInfo = {
    category: benchmarkCategory,
    co2PerXlmTypical: benchmark.co2_per_xlm_typical,
    maxReasonable: benchmark.max_reasonable,
  };

  const rate =
    typeof co2PerXLM === "number" ? co2PerXLM : Number.parseFloat(co2PerXLM);
  // An unparseable or negative rate can't be vouched for automatically, so
  // fail closed: flag it rather than let it slip through as verified.
  if (!Number.isFinite(rate) || rate < 0) {
    return {
      status: "flagged",
      reason: `CO₂ rate "${co2PerXLM}" is not a valid non-negative number`,
      multiplier: null,
      benchmark: benchmarkInfo,
    };
  }

  const multiplier = rate / benchmark.co2_per_xlm_typical;

  if (multiplier > FLAG_MULTIPLIER) {
    return {
      status: "flagged",
      reason:
        `Rate ${rate} kg/XLM is ${multiplier.toFixed(1)}× the ` +
        `${benchmarkCategory} benchmark of ${benchmark.co2_per_xlm_typical} kg/XLM`,
      multiplier,
      benchmark: benchmarkInfo,
    };
  }
  if (multiplier > REVIEW_MULTIPLIER) {
    return {
      status: "review",
      reason:
        `Rate ${rate} kg/XLM is ${multiplier.toFixed(1)}× the typical ` +
        `${benchmarkCategory} rate of ${benchmark.co2_per_xlm_typical} kg/XLM`,
      multiplier,
      benchmark: benchmarkInfo,
    };
  }
  return {
    status: "verified",
    reason: null,
    multiplier,
    benchmark: benchmarkInfo,
  };
}

/**
 * Run verifyCO2Rate() for an approved verification request and stamp the
 * verdict onto the matching projects row(s).
 *
 * The verification_requests table has no project_id foreign key, so the
 * project is matched by (wallet_address, name) — the same pair the /apply
 * form submits. When no project row exists yet (the project is registered
 * after approval), nothing is updated and the verdict is still returned so
 * the caller can surface it; the projects row keeps its "pending" default
 * until re-checked.
 *
 * @param {object} params
 * @param {string} params.walletAddress - Stellar wallet of the applicant.
 * @param {string} params.projectName - Project name from the request.
 * @param {string} params.category - Project category from the request.
 * @param {number|string} params.co2PerXLM - Claimed kg CO₂ per XLM.
 * @param {string} [params.requestId] - Verification request id, for logs.
 * @returns {Promise<object>} verifyCO2Rate() result plus projectIds[].
 */
async function applyCO2VerificationToProject({
  walletAddress,
  projectName,
  category,
  co2PerXLM,
  requestId,
}) {
  const result = verifyCO2Rate(category, co2PerXLM);

  const updated = await pool.query(
    `UPDATE projects
        SET co2_verification_status = $1,
            co2_verification_notes = $2,
            updated_at = NOW()
      WHERE wallet_address = $3 AND name = $4
      RETURNING id`,
    [result.status, result.reason, walletAddress, projectName],
  );
  const projectIds = updated.rows.map((r) => r.id);

  if (result.status === "flagged") {
    logger.warn(
      {
        event: "co2_rate_flagged",
        requestId: requestId || null,
        projectIds,
        walletAddress,
        projectName,
        category,
        co2PerXLM,
        multiplier: result.multiplier,
        reason: result.reason,
      },
      "CO₂ offset rate flagged as implausible — admin resolution required",
    );
  } else if (projectIds.length === 0) {
    logger.info(
      {
        event: "co2_verification_no_project",
        requestId: requestId || null,
        walletAddress,
        projectName,
      },
      "CO₂ verification ran but no matching projects row exists yet",
    );
  }

  return { ...result, projectIds };
}

module.exports = {
  CATEGORY_BENCHMARKS,
  CO2_VERIFICATION_STATUSES,
  REVIEW_MULTIPLIER,
  FLAG_MULTIPLIER,
  verifyCO2Rate,
  applyCO2VerificationToProject,
};
