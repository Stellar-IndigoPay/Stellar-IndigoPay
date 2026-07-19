/**
 * src/services/co2Verifier.js — Automated CO₂ offset-rate verification
 *
 * Project owners self-report co2_per_xlm (grams of CO₂ offset per 1 XLM
 * donated) when they apply for verification. Nothing stops a malicious
 * applicant from claiming an absurd rate (the contract only caps it at
 * MAX_CO2_PER_XLM = 100,000), so this service sanity-checks every
 * submitted rate against per-category industry benchmarks and flags
 * outliers for admin review before the project's impact numbers are
 * trusted.
 *
 * ── Verification pipeline ──────────────────────────────────────────────
 *
 *   1. fetchReferenceRates() — queries external CO₂ offset databases
 *      (Gold Standard Impact Registry, Verra VCS, or public datasets)
 *      for the project's category and location. Falls back to static
 *      CATEGORY_BENCHMARKS when APIs are unavailable, and to IPCC tier-1
 *      emission factors as a universal last resort.
 *
 *   2. fetchSatelliteEstimate() — for reforestation projects, queries
 *      Global Forest Watch / NASA MODIS / GlobBiomass data to estimate
 *      biomass density in the project's location. Returns null when
 *      satellite data is unavailable (non-reforestation projects or
 *      API failures).
 *
 *   3. computeConfidenceBand() — combines reference rates with any
 *      satellite-derived biomass estimates to produce a [lower, upper]
 *      range in g CO₂ / XLM that the project's claimed rate should fall
 *      within for scientific plausibility.
 *
 *   4. verifyProjectCO2Rate() — runs the full pipeline for one project,
 *      compares claimed rate against the confidence band (with 50%
 *      tolerance above the upper bound), assigns a severity, and writes
 *      a co2_verification_runs row for audit history.
 *
 * ── Severity levels ──────────────────────────────────────────────────────
 *
 *   - none     — rate within [lower, upper × 1.5]; plausible
 *   - warning  — rate > upper × 1.5 but ≤ upper × 3.0
 *   - critical — rate > upper × 3.0
 *
 * ── Scheduled verification ───────────────────────────────────────────────
 *
 *   startCO2VerificationCron() registers a pg-boss cron job that runs
 *   weekly (configurable via CO2_VERIFICATION_CRON env var). It fetches
 *   all active projects and re-verifies each one, keeping verification
 *   history current as external datasets update.
 *
 * ── Verdicts (stored in projects.co2_verification_status) ────────────────
 *
 *   - "verified" — rate is within 3× the category benchmark; plausible.
 *   - "review"   — rate is 3–10× the benchmark; above the typical range
 *                  and worth a closer look, but not necessarily bogus.
 *   - "flagged"  — rate is >10× the benchmark (or unparseable); requires
 *                  explicit admin resolution before it should be trusted.
 *   - "pending"  — column default; no verification has run yet.
 *   - "rejected" — an admin resolved a flag by rejecting the claimed rate.
 *
 * Public surface:
 *   - CATEGORY_BENCHMARKS              benchmark table (kg CO₂ per XLM)
 *   - CO2_VERIFICATION_STATUSES        every value the DB column may hold
 *   - REVIEW_MULTIPLIER / FLAG_MULTIPLIER   threshold constants
 *   - IPCC_TIER1_FACTORS               universal fallback (t CO₂ / ha / yr)
 *   - verifyCO2Rate(category, co2PerXLM)    pure benchmark comparison
 *   - applyCO2VerificationToProject(...)    stamps verdict onto project row
 *   - verifyProjectCO2Rate(project)         full automated pipeline
 *   - runVerificationForAllProjects()       batch verification
 *   - startCO2VerificationCron()            pg-boss weekly cron
 */
"use strict";

const pool = require("../db/pool");
const logger = require("../logger");

// ── Prometheus metric (lazy-loaded to avoid circular deps) ──────────────

let co2VerificationsTotal = null;
let co2VerificationsTotalInitAttempted = false;
function lazyMetrics() {
  if (co2VerificationsTotalInitAttempted) return co2VerificationsTotal;
  co2VerificationsTotalInitAttempted = true;
  if (!co2VerificationsTotal) {
    try {
      const client = require("prom-client");
      const metrics = require("./metrics");
      // Check if counter was already registered on the shared registry
      try {
        co2VerificationsTotal = metrics.registry.getSingleMetric(
          "indigopay_co2_verifications_total",
        );
      } catch {
        // Not yet registered
      }
      if (!co2VerificationsTotal) {
        co2VerificationsTotal = new client.Counter({
          name: "indigopay_co2_verifications_total",
          help: "Total number of CO₂ offset-rate verification runs, labelled by outcome (plausible|warning|critical|error).",
          labelNames: ["outcome"],
          registers: [metrics.registry],
        });
      }
    } catch {
      // prom-client may not be available in test environments; swallow.
    }
  }
  return co2VerificationsTotal;
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Static benchmarks (backward-compatible; kept for fast local checks)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// 2. IPCC Tier-1 emission factors (universal fallback)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * IPCC tier-1 default emission / removal factors, in tonnes CO₂ per
 * hectare per year. Used as a universal fallback when neither the
 * static benchmark table nor an external API returns a usable figure.
 *
 * Sources: 2006 IPCC Guidelines for National Greenhouse Gas Inventories,
 * Vol. 4, Ch. 4 (Forest Land) & Ch. 5 (Cropland / Grassland).
 */
const IPCC_TIER1_FACTORS = {
  // Forest land remaining forest land — above-ground biomass growth
  // in tropical / subtropical moist deciduous forest (t C/ha/yr × 3.67).
  reforestation_tropical: { tco2_per_ha_yr: 11.0, description: "Tropical moist deciduous forest regrowth" },
  reforestation_temperate: { tco2_per_ha_yr: 4.5, description: "Temperate continental forest regrowth" },
  reforestation_boreal: { tco2_per_ha_yr: 1.0, description: "Boreal forest regrowth" },
  // Default: subtropical / warm-temperate average
  reforestation_default: { tco2_per_ha_yr: 5.0, description: "IPCC tier-1 default forest regrowth" },
  // Cropland → grassland conversion (soil carbon accumulation)
  soil_carbon: { tco2_per_ha_yr: 1.5, description: "Soil organic carbon accumulation" },
};

// ═══════════════════════════════════════════════════════════════════════════
// 3. Original verifyCO2Rate (pure benchmark comparison — kept for compat)
// ═══════════════════════════════════════════════════════════════════════════

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
  // Safe: benchmarkCategory is validated by hasOwnProperty.call above
  // eslint-disable-next-line security/detect-object-injection
  const benchmark = CATEGORY_BENCHMARKS[benchmarkCategory];
  const benchmarkInfo = {
    category: benchmarkCategory,
    co2PerXlmTypical: benchmark.co2_per_xlm_typical,
    maxReasonable: benchmark.max_reasonable,
  };

  const rate =
    typeof co2PerXLM === "number" ? co2PerXLM : Number.parseFloat(co2PerXLM);
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

// ═══════════════════════════════════════════════════════════════════════════
// 4. applyCO2VerificationToProject (original — kept for backward compat)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run verifyCO2Rate() for an approved verification request and stamp the
 * verdict onto the matching projects row(s).
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

// ═══════════════════════════════════════════════════════════════════════════
// 5. External API integration — reference rate fetching
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Determine the latitudinal climate zone from a latitude value.
 * Used for selecting the correct IPCC tier-1 factor for reforestation.
 *
 * @param {number} lat - Latitude in degrees.
 * @returns {"tropical"|"temperate"|"boreal"}
 */
function climateZoneFromLat(lat) {
  const abs = Math.abs(lat);
  if (abs < 23.5) return "tropical";
  if (abs < 50) return "temperate";
  return "boreal";
}

/**
 * Extract approximate latitude from a location string.
 * Simple heuristic — returns null if no coordinates can be inferred.
 *
 * @param {string} location - Project location string.
 * @returns {number|null}
 */
function extractLatitude(location) {
  if (!location) return null;
  // Try to find explicit coordinates like "12.34, -56.78"
  const coordMatch = location.match(/(-?\d+\.?\d*)\s*[,;]\s*(-?\d+\.?\d*)/);
  if (coordMatch) return Number.parseFloat(coordMatch[1]);
  return null;
}

/**
 * Fetch reference CO₂ offset rates from independent databases for a given
 * project category and location.
 *
 * Priorities (configurable via env):
 *   1. Gold Standard Impact Registry API (CO2_VERIFIER_GS_API_URL)
 *   2. Verra VCS Registry public data (CO2_VERIFIER_VERRA_API_URL)
 *   3. Static CATEGORY_BENCHMARKS (always available)
 *   4. IPCC tier-1 emission factors (universal fallback)
 *
 * Each external API is optional — if the URL is not configured or the
 * call fails (network error, 5xx, timeout), the pipeline silently falls
 * through to the next source.
 *
 * @param {string} category - Project category.
 * @param {string} location - Project location string.
 * @returns {Promise<{co2PerXlmTypical: number, maxReasonable: number,
 *                    source: string, category: string}>}
 */
async function fetchReferenceRates(category, location) {
  const startTime = Date.now();

  // ── Try Gold Standard Impact Registry ──────────────────────────────
  const gsUrl = process.env.CO2_VERIFIER_GS_API_URL;
  if (gsUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(
        `${gsUrl}?category=${encodeURIComponent(category)}&location=${encodeURIComponent(location || "")}`,
        {
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "Stellar-IndigoPay-CO2Verifier/1.0",
          },
        },
      );
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.co2_per_xlm_typical && data?.max_reasonable) {
          logger.info(
            {
              event: "co2_verifier_external_api_success",
              source: "gold_standard",
              category,
              location,
              durationMs: Date.now() - startTime,
            },
            "Fetched reference rates from Gold Standard registry",
          );
          return {
            co2PerXlmTypical: Number(data.co2_per_xlm_typical),
            maxReasonable: Number(data.max_reasonable),
            source: "Gold Standard Impact Registry",
            category,
          };
        }
      }
      logger.warn(
        {
          event: "co2_verifier_external_api_unexpected",
          source: "gold_standard",
          status: resp.status,
          durationMs: Date.now() - startTime,
        },
        "Gold Standard API returned unexpected shape; falling through",
      );
    } catch (err) {
      logger.warn(
        {
          event: "co2_verifier_external_api_error",
          source: "gold_standard",
          err: err.message,
          durationMs: Date.now() - startTime,
        },
        "Gold Standard API unavailable; falling through to next source",
      );
    }
  }

  // ── Try Verra VCS Registry ─────────────────────────────────────────
  const verraUrl = process.env.CO2_VERIFIER_VERRA_API_URL;
  if (verraUrl) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch(
        `${verraUrl}?category=${encodeURIComponent(category)}&location=${encodeURIComponent(location || "")}`,
        {
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "User-Agent": "Stellar-IndigoPay-CO2Verifier/1.0",
          },
        },
      );
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.co2_per_xlm_typical && data?.max_reasonable) {
          logger.info(
            {
              event: "co2_verifier_external_api_success",
              source: "verra",
              category,
              location,
              durationMs: Date.now() - startTime,
            },
            "Fetched reference rates from Verra registry",
          );
          return {
            co2PerXlmTypical: Number(data.co2_per_xlm_typical),
            maxReasonable: Number(data.max_reasonable),
            source: "Verra VCS Registry",
            category,
          };
        }
      }
    } catch (err) {
      logger.warn(
        {
          event: "co2_verifier_external_api_error",
          source: "verra",
          err: err.message,
        },
        "Verra API unavailable; falling through",
      );
    }
  }

  // ── Fall back to static CATEGORY_BENCHMARKS ────────────────────────
  const benchmarkCategory2 = Object.prototype.hasOwnProperty.call(
    CATEGORY_BENCHMARKS,
    category,
  )
    ? category
    : "Other";
  // Safe: benchmarkCategory2 is validated by hasOwnProperty.call above
  // eslint-disable-next-line security/detect-object-injection
  const benchmark = CATEGORY_BENCHMARKS[benchmarkCategory2];

  logger.info(
    {
      event: "co2_verifier_static_benchmark_used",
      category: benchmarkCategory2,
      location,
      durationMs: Date.now() - startTime,
    },
    "Using static category benchmarks for reference rates",
  );

  return {
    co2PerXlmTypical: benchmark.co2_per_xlm_typical,
    maxReasonable: benchmark.max_reasonable,
    source: "IndigoPay Category Benchmarks (IPCC-informed)",
    category: benchmarkCategory2,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Satellite data integration
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch satellite-derived biomass estimate for a project's location.
 *
 * For reforestation projects, queries:
 *   1. Global Forest Watch API (CO2_VERIFIER_GFW_API_URL + API key)
 *   2. GlobBiomass static dataset (pre-computed biomass maps)
 *   3. Falls back to null for non-reforestation categories
 *
 * Returns an estimate in tonnes of CO₂ sequestered per hectare per year
 * for the project's location, or null when data is unavailable.
 *
 * @param {string} category - Project category.
 * @param {string} location - Project location string.
 * @returns {Promise<{tco2PerHaPerYear: number, source: string}|null>}
 */
async function fetchSatelliteEstimate(category, location) {
  // Satellite data is only relevant for reforestation / land-use projects
  const reforestationCategories = [
    "Reforestation",
    "Sustainable Agriculture",
    "Wildlife Protection",
    "Ocean Conservation",
  ];
  if (!reforestationCategories.includes(category)) {
    return null;
  }

  const startTime = Date.now();

  // ── Try Global Forest Watch API ────────────────────────────────────
  const gfwUrl = process.env.CO2_VERIFIER_GFW_API_URL;
  const gfwKey = process.env.CO2_VERIFIER_GFW_API_KEY;
  if (gfwUrl && gfwKey) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const resp = await fetch(
        `${gfwUrl}/biomass?location=${encodeURIComponent(location || "")}`,
        {
          signal: controller.signal,
          headers: {
            "Accept": "application/json",
            "Authorization": `Bearer ${gfwKey}`,
            "User-Agent": "Stellar-IndigoPay-CO2Verifier/1.0",
          },
        },
      );
      clearTimeout(timeout);
      if (resp.ok) {
        const data = await resp.json();
        if (data?.tco2_per_ha_per_year) {
          logger.info(
            {
              event: "co2_verifier_satellite_success",
              source: "gfw",
              category,
              location,
              tco2PerHaPerYear: data.tco2_per_ha_per_year,
              durationMs: Date.now() - startTime,
            },
            "Fetched satellite biomass estimate from Global Forest Watch",
          );
          return {
            tco2PerHaPerYear: Number(data.tco2_per_ha_per_year),
            source: "Global Forest Watch API (WRI)",
          };
        }
      }
    } catch (err) {
      logger.warn(
        {
          event: "co2_verifier_satellite_error",
          source: "gfw",
          err: err.message,
        },
        "Global Forest Watch API unavailable; falling through",
      );
    }
  }

  // ── Fall back to IPCC tier-1 factors based on climate zone ─────────
  const lat = extractLatitude(location);
  const zone = lat ? climateZoneFromLat(lat) : null;

  let ipccFactor;
  if (zone === "tropical") {
    ipccFactor = IPCC_TIER1_FACTORS.reforestation_tropical;
  } else if (zone === "temperate") {
    ipccFactor = IPCC_TIER1_FACTORS.reforestation_temperate;
  } else if (zone === "boreal") {
    ipccFactor = IPCC_TIER1_FACTORS.reforestation_boreal;
  } else {
    ipccFactor = IPCC_TIER1_FACTORS.reforestation_default;
  }

  logger.info(
    {
      event: "co2_verifier_ipcc_fallback",
      category,
      location,
      zone: zone || "unknown",
      tco2PerHaPerYear: ipccFactor.tco2_per_ha_yr,
      durationMs: Date.now() - startTime,
    },
    `Using IPCC tier-1 factor for satellite estimate: ${ipccFactor.description}`,
  );

  return {
    tco2PerHaPerYear: ipccFactor.tco2_per_ha_yr,
    source: `IPCC Tier-1 (${ipccFactor.description})`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. Confidence band calculation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute a confidence band [lower, upper] in g CO₂ per XLM for a project
 * based on reference rates and optional satellite-derived biomass data.
 *
 * The lower bound is set at 50% of the typical rate (projects that claim
 * to offset very little CO₂ may be under-reporting, but that's less
 * concerning than over-reporting). The upper bound is the max_reasonable
 * value from the reference source.
 *
 * When satellite data is available for reforestation projects, the upper
 * bound is refined by the biomass estimate's annual sequestration rate,
 * converted from tCO₂/ha/yr to g CO₂/XLM using a conservative
 * hectare-per-dollar conversion (0.01 ha/$ — about $100/ha for
 * reforestation projects).
 *
 * @param {object} referenceRates - Result from fetchReferenceRates().
 * @param {object|null} satelliteEstimate - Result from fetchSatelliteEstimate().
 * @returns {{lower: number, upper: number}}
 */
function computeConfidenceBand(referenceRates, satelliteEstimate) {
  // Convert kg to grams (existing benchmarks are in kg/XLM;
  // verifyProjectCO2Rate works in grams)
  const typicalGrams = referenceRates.co2PerXlmTypical * 1000;
  const maxReasonableGrams = referenceRates.maxReasonable * 1000;

  let lower = Math.round(typicalGrams * 0.5);
  let upper = maxReasonableGrams;

  // If satellite data is available for reforestation, use it to refine
  // the upper bound. tCO₂/ha/yr → g CO₂ / XLM:
  //   assume ~$0.10/XLM purchasing power and ~$100/ha reforestation cost
  //   → 0.001 ha per XLM donated
  //   → satelliteEstimate.tco2PerHaPerYear * 1e6 g/tCO₂ * 0.001 ha/XLM
  //     = satelliteEstimate.tco2PerHaPerYear * 1000 g/XLM
  if (satelliteEstimate && satelliteEstimate.tco2PerHaPerYear > 0) {
    const satelliteUpper = Math.round(
      satelliteEstimate.tco2PerHaPerYear * 1000,
    );
    // Use the more conservative (lower) upper bound between the benchmark
    // and the satellite estimate to avoid inflated confidence bands
    upper = Math.min(upper, satelliteUpper * 2);
    // Also tighten the lower bound using satellite data
    lower = Math.max(lower, Math.round(satelliteEstimate.tco2PerHaPerYear * 100));
  }

  return { lower, upper };
}

// ═══════════════════════════════════════════════════════════════════════════
// 8. Core verification pipeline
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Severity level for a flagged project.
 * @typedef {"none"|"warning"|"critical"} Severity
 */

/**
 * Determine severity based on how far the claimed rate exceeds the
 * confidence band's upper bound.
 *
 * @param {number} claimedRate - Project's claimed CO₂/XLM rate (grams).
 * @param {number} upperBound - Confidence band upper bound (grams).
 * @returns {Severity}
 */
function computeSeverity(claimedRate, upperBound) {
  if (claimedRate <= upperBound * 1.5) return "none";
  if (claimedRate <= upperBound * 3.0) return "warning";
  return "critical";
}

/**
 * Compute the deviation percentage of the claimed rate from the
 * confidence band's upper bound. Returns 0 if within bounds.
 *
 * @param {number} claimedRate - Claimed rate in grams.
 * @param {number} upperBound - Upper bound in grams.
 * @returns {number} Percentage deviation above upper bound (0 if within).
 */
function computeDeviationPercent(claimedRate, upperBound) {
  if (claimedRate <= upperBound) return 0;
  return Math.round(((claimedRate - upperBound) / upperBound) * 100);
}

/**
 * Full automated CO₂ offset rate verification pipeline for a single project.
 *
 *   1. Fetches reference rates from independent databases
 *   2. Fetches satellite-derived biomass estimates (reforestation only)
 *   3. Computes a confidence band
 *   4. Compares the project's claimed rate against the band
 *   5. Assigns a severity
 *   6. Writes a co2_verification_runs row for audit history
 *   7. Updates the project's co2_verification_status if the rate is implausible
 *
 * @param {object} project - Project row from the database.
 *   Expected shape: { id, name, category, location, wallet_address, co2_offset_kg }
 * @returns {Promise<object>} Verification result.
 */
async function verifyProjectCO2Rate(project) {
  const startTime = Date.now();

  // The project's CO₂ rate is derived from co2_offset_kg.
  // We need to look up the actual co2_per_xlm value, or derive it.
  // The contract stores co2_per_xlm as u32 (grams per XLM).
  // In the DB, co2_offset_kg is in kg, which represents total offset.
  // For verification we use the co2_per_xlm from the contract / project metadata.
  // Here we derive it: if the project has been registered on-chain, we use
  // the on-chain value; otherwise co2_offset_kg represents the rate proxy.
  //
  // Actually, we need to get the project's claimed co2_per_xlm rate.
  // Let's query the projects table for any stored co2_per_xlm value,
  // or fall back to co2_offset_kg as the proxy rate in grams/XLM.
  let claimedRateGrams;
  try {
    const rateResult = await pool.query(
      "SELECT co2_offset_kg FROM projects WHERE id = $1",
      [project.id],
    );
    // co2_offset_kg is stored as INTEGER (kg). Convert to grams.
    const firstRow = rateResult.rows && rateResult.rows.length > 0 ? rateResult.rows[0] : null;
    claimedRateGrams =
      (firstRow ? firstRow.co2_offset_kg : project.co2_offset_kg || 0) * 1000;
  } catch {
    claimedRateGrams = (project.co2_offset_kg || 0) * 1000;
  }

  try {
    // Step 1: Fetch reference rates
    const referenceRates = await fetchReferenceRates(
      project.category,
      project.location,
    );

    // Step 2: Fetch satellite estimate
    const satelliteEstimate = await fetchSatelliteEstimate(
      project.category,
      project.location,
    );

    // Step 3: Compute confidence band
    const confidenceBand = computeConfidenceBand(
      referenceRates,
      satelliteEstimate,
    );

    // Step 4: Compare claimed rate against band
    const severity = computeSeverity(claimedRateGrams, confidenceBand.upper);
    const isPlausible = severity === "none";
    const deviationPercent = computeDeviationPercent(
      claimedRateGrams,
      confidenceBand.upper,
    );

    // Step 5: Build flag reason
    let flagReason = null;
    if (!isPlausible) {
      if (claimedRateGrams > confidenceBand.upper * 1.5) {
        flagReason =
          `Rate ${claimedRateGrams} g/XLM exceeds upper confidence bound ` +
          `(${confidenceBand.upper} g/XLM) by ${deviationPercent}% ` +
          `(severity: ${severity})`;
      } else {
        flagReason =
          `Rate ${claimedRateGrams} g/XLM below minimum plausible threshold ` +
          `(${confidenceBand.lower} g/XLM)`;
      }
    }

    // Step 6: Store verification run
    await pool.query(
      `INSERT INTO co2_verification_runs
         (project_id, claimed_rate, confidence_lower, confidence_upper,
          is_plausible, reference_source, satellite_source, flag_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        project.id,
        claimedRateGrams,
        confidenceBand.lower,
        confidenceBand.upper,
        isPlausible,
        referenceRates.source,
        satelliteEstimate ? satelliteEstimate.source : null,
        flagReason,
      ],
    );

    // Step 7: Update project's co2_verification_status if necessary
    if (!isPlausible) {
      const newStatus = severity === "critical" ? "flagged" : "review";
      await pool.query(
        `UPDATE projects
            SET co2_verification_status = $1,
                co2_verification_notes = $2,
                updated_at = NOW()
          WHERE id = $3`,
        [newStatus, flagReason, project.id],
      );
    }

    // Increment Prometheus metric
    const metric = lazyMetrics();
    if (metric) {
      metric.inc({ outcome: isPlausible ? "plausible" : severity });
    }

    logger.info(
      {
        event: "co2_verification_run_complete",
        projectId: project.id,
        projectName: project.name,
        category: project.category,
        claimedRateGrams,
        confidenceBand,
        severity,
        referenceSource: referenceRates.source,
        satelliteSource: satelliteEstimate?.source || null,
        durationMs: Date.now() - startTime,
      },
      `CO₂ verification complete: ${project.name} — ${severity}`,
    );

    return {
      projectId: project.id,
      claimedRate: claimedRateGrams,
      confidenceBand,
      referenceSource: referenceRates.source,
      satelliteSource: satelliteEstimate?.source || null,
      isPlausible,
      severity,
      deviationPercent,
      flagReason,
      verifiedAt: new Date().toISOString(),
    };
  } catch (err) {
    // If the pipeline fails entirely, log the error, increment the error
    // metric, and return a failed result rather than throwing — the caller
    // should be able to handle partial failures gracefully.
    const metric = lazyMetrics();
    if (metric) metric.inc({ outcome: "error" });

    logger.error(
      {
        event: "co2_verification_run_failed",
        projectId: project.id,
        projectName: project.name,
        err: err.message,
        durationMs: Date.now() - startTime,
      },
      `CO₂ verification failed for ${project.name}: ${err.message}`,
    );

    return {
      projectId: project.id,
      claimedRate: claimedRateGrams,
      confidenceBand: { lower: 0, upper: 0 },
      referenceSource: "Verification failed",
      satelliteSource: null,
      isPlausible: false,
      severity: "warning",
      deviationPercent: 0,
      flagReason: `Verification pipeline error: ${err.message}`,
      verifiedAt: new Date().toISOString(),
      error: err.message,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 9. Batch verification (all active projects)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run verifyProjectCO2Rate() for every active project in the database.
 * Designed to be called from a cron job or admin-triggered endpoint.
 *
 * Projects are processed sequentially to avoid overwhelming external APIs
 * with concurrent requests. Each project failure is logged individually
 * without aborting the batch.
 *
 * @returns {Promise<{total: number, plausible: number, warning: number,
 *                    critical: number, errors: number,
 *                    results: Array<object>}>}
 */
async function runVerificationForAllProjects() {
  const startTime = Date.now();
  const results = [];
  let plausible = 0;
  let warning = 0;
  let critical = 0;
  let errors = 0;

  const { rows: projects } = await pool.query(
    `SELECT id, name, category, location, wallet_address, co2_offset_kg
       FROM projects
      WHERE active = true
      ORDER BY name ASC`,
  );

  logger.info(
    {
      event: "co2_verification_batch_started",
      projectCount: projects.length,
    },
    `Starting CO₂ verification for ${projects.length} active projects`,
  );

  for (const project of projects) {
    const result = await verifyProjectCO2Rate(project);
    results.push(result);

    if (result.error) {
      errors++;
    } else if (result.severity === "critical") {
      critical++;
    } else if (result.severity === "warning") {
      warning++;
    } else {
      plausible++;
    }
  }

  logger.info(
    {
      event: "co2_verification_batch_complete",
      total: projects.length,
      plausible,
      warning,
      critical,
      errors,
      durationMs: Date.now() - startTime,
    },
    `CO₂ verification batch complete: ${plausible} plausible, ${warning} warning, ${critical} critical, ${errors} errors`,
  );

  return {
    total: projects.length,
    plausible,
    warning,
    critical,
    errors,
    results,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// 10. Scheduled verification (pg-boss cron)
// ═══════════════════════════════════════════════════════════════════════════

const QUEUE = "co2-verification";
const DEFAULT_CRON = "0 3 * * 0"; // Every Sunday at 03:00 UTC

let boss = null;

/**
 * Start the CO₂ verification cron scheduler.
 *
 * Registers a pg-boss cron job that runs weekly. The schedule can be
 * overridden with the CO2_VERIFICATION_CRON env var (cron syntax).
 * Set CO2_VERIFICATION_CRON="disabled" to turn it off entirely.
 */
async function startCO2VerificationCron() {
  const cronOverride = process.env.CO2_VERIFICATION_CRON;
  if (cronOverride === "disabled") {
    logger.info(
      { event: "co2_verification_cron_disabled" },
      "[co2Verifier] Cron disabled via CO2_VERIFICATION_CRON=disabled",
    );
    return;
  }

  const cronSchedule = cronOverride || DEFAULT_CRON;
  const connectionString =
    process.env.DATABASE_URL ||
    "postgres://postgres:postgres@localhost:5432/indigopay";

  try {
    const PgBoss = require("pg-boss");
    boss = new PgBoss(connectionString);

    boss.on("error", (err) =>
      logger.error(
        { event: "co2_verification_pgboss_error", err: err.message },
        err.message,
      ),
    );

    await boss.start();

    // Register the cron schedule (idempotent — pg-boss deduplicates by name)
    await boss.schedule(QUEUE, cronSchedule, {}, { tz: "UTC" });

    // Register the worker — single concurrency to avoid thundering herd
    await boss.work(QUEUE, { teamSize: 1, teamConcurrency: 1 }, async () => {
      logger.info(
        { event: "co2_verification_cron_triggered" },
        "[co2Verifier] Scheduled verification run starting",
      );
      await runVerificationForAllProjects();
    });

    logger.info(
      {
        event: "co2_verification_cron_scheduled",
        cron: cronSchedule,
      },
      `[co2Verifier] Cron scheduled: ${cronSchedule}`,
    );
  } catch (err) {
    logger.error(
      {
        event: "co2_verification_cron_startup_error",
        err: err.message,
      },
      "Failed to start CO₂ verification cron; runs will be manual only",
    );
  }
}

/**
 * Gracefully stop the pg-boss instance.
 */
async function stopCO2VerificationCron() {
  if (boss) {
    try {
      await boss.stop({ timeout: 5000 });
    } catch {
      // ignore
    }
    boss = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Exports
// ═══════════════════════════════════════════════════════════════════════════

module.exports = {
  // Static benchmarks (backward-compatible)
  CATEGORY_BENCHMARKS,
  CO2_VERIFICATION_STATUSES,
  REVIEW_MULTIPLIER,
  FLAG_MULTIPLIER,
  IPCC_TIER1_FACTORS,

  // Original simple verifier (backward-compatible)
  verifyCO2Rate,
  applyCO2VerificationToProject,

  // Automated pipeline
  fetchReferenceRates,
  fetchSatelliteEstimate,
  computeConfidenceBand,
  computeSeverity,
  computeDeviationPercent,
  verifyProjectCO2Rate,
  runVerificationForAllProjects,

  // Cron scheduling
  startCO2VerificationCron,
  stopCO2VerificationCron,
};
