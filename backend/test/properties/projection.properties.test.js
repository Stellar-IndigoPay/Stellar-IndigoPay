"use strict";

/**
 * backend/test/properties/projection.properties.test.js
 *
 * Property-based tests for the projection engine's arithmetic invariants,
 * driven through the REAL production handlers (harness/projectionTestDb)
 * and the REAL exported decimal helpers, with an independent BigInt oracle.
 *
 * Failures print the seed; replay with:
 *   PROPERTY_SEED=<base> npx jest test/properties
 */

const { checkProperty } = require("./harness/property");
const {
  co2DistributionInvariantProperty,
  decimalExactnessProperty,
  impactScoreInvariantProperty,
  projectionMonotonicityProperty,
  projectionReplayParityProperty,
  projectionTotalsDecomposeProperty,
} = require("./harness/soundness");
const { resolveIterations, suiteSeed } = require("./harness/rng");
const {
  decimalString,
  digitString,
  hexText,
  smallNumber,
  text,
} = require("./harness/generators");
const { toScaled } = require("./harness/exactDecimal");

const SEED = suiteSeed(1);
const iterations = () => resolveIterations();
const half = () => Math.max(1, Math.floor(resolveIterations() / 2));

/** One random DonationRecorded event with exact-decimal financial fields. */
function genDonationSet(rng) {
  const events = [];
  const count = rng.int(1, 40);
  for (let i = 0; i < count; i += 1) {
    // Huge amounts stay strings on purpose: they exceed Number's exact range.
    const amountXLM =
      rng.chance(0.35)
        ? decimalString(rng, { maxIntDigits: 18, maxFracDigits: 7 })
        : rng.chance(0.3)
          ? smallNumber(rng, 1000000)
          : decimalString(rng, { maxIntDigits: 9, maxFracDigits: 7 });
    const txHash = `tx-${i}-${hexText(rng, 16)}`;
    events.push({
      event_type: "DonationRecorded",
      aggregate_id: `proj-${rng.int(1, 4)}`,
      transaction_hash: txHash,
      event_data: {
        donorAddress: `G${hexText(rng, 12)}`,
        amountXLM,
        co2OffsetKg: decimalString(rng, { maxIntDigits: 10, maxFracDigits: 4 }),
        projectsSupported: rng.int(1, 5),
        currency: "XLM",
        message: rng.chance(0.3) ? text(rng, 0, 20) : null,
        anonymous: rng.chance(0.1),
        transactionHash: txHash,
      },
    });
  }
  return { events };
}

function orderedPair(rng, maxIntDigits, maxFracDigits, scale) {
  let a = decimalString(rng, { maxIntDigits, maxFracDigits });
  let b = decimalString(rng, { maxIntDigits, maxFracDigits });
  if (toScaled(a, scale) > toScaled(b, scale)) [a, b] = [b, a];
  return [a, b];
}

describe("projection engine properties", () => {
  test("property: totals decompose per donor/project/globally, non-negative, exact", async () => {
    await checkProperty({
      name: "projection totals decompose",
      seed: SEED + 11,
      iterations: half(),
      gen: genDonationSet,
      predicate: projectionTotalsDecomposeProperty,
    });
  });

  test("property: totals are monotonic under appended donations", async () => {
    await checkProperty({
      name: "projection monotonicity",
      seed: SEED + 22,
      iterations: half(),
      gen: genDonationSet,
      predicate: projectionMonotonicityProperty,
    });
  });

  test("property: bulk rebuild equals incremental replay and re-projection is idempotent", async () => {
    await checkProperty({
      name: "projection replay parity/idempotence",
      seed: SEED + 33,
      iterations: half(),
      gen: genDonationSet,
      predicate: projectionReplayParityProperty,
    });
  });

  test("property: decimal helpers are BigInt-exact past Number.MAX_SAFE_INTEGER", async () => {
    await checkProperty({
      name: "decimal BigInt exactness",
      seed: SEED + 44,
      iterations: iterations(),
      gen: (rng) => {
        const values = [];
        for (let i = 0, n = rng.int(1, 12); i < n; i += 1) {
          values.push(
            rng.chance(0.3)
              ? smallNumber(rng, 9007199)
              : decimalString(rng, { maxIntDigits: 14, maxFracDigits: 7 }),
          );
        }
        const hugeValues = [];
        for (let i = 0, n = rng.int(1, 8); i < n; i += 1) {
          hugeValues.push(decimalString(rng, { maxIntDigits: 30, maxFracDigits: 7 }));
        }
        const scale = rng.int(1, 8);
        const fracLen = scale + rng.int(1, 4);
        return {
          values,
          hugeValues,
          overScaleValue: {
            value: `${digitString(rng, 1, 8)}.${digitString(rng, fracLen, fracLen)}`,
            scale,
          },
        };
      },
      predicate: decimalExactnessProperty,
    });
  });

  test("property: impact score is deterministic, non-negative and monotone", async () => {
    await checkProperty({
      name: "impact score invariants",
      seed: SEED + 55,
      iterations: iterations(),
      gen: (rng) => {
        const [xlmLow, xlmHigh] = orderedPair(rng, 16, 7, 7);
        const [co2Low, co2High] = orderedPair(rng, 12, 4, 4);
        return { xlmLow, xlmHigh, co2Low, co2High };
      },
      predicate: impactScoreInvariantProperty,
    });
  });

  test("property: CO2 distribution follows the proportional formula exactly", async () => {
    await checkProperty({
      name: "CO2 distribution invariants",
      seed: SEED + 66,
      iterations: iterations(),
      gen: (rng) => {
        const [amountLow, amountHigh] = orderedPair(rng, 16, 7, 7);
        const raised = rng.chance(0.15) ? "0" : decimalString(rng, { maxIntDigits: 14, maxFracDigits: 7 });
        const co2 = rng.chance(0.15) ? "0" : decimalString(rng, { maxIntDigits: 10, maxFracDigits: 4 });
        return { amountLow, amountHigh, raised, co2, multiplier: rng.int(2, 9) };
      },
      predicate: co2DistributionInvariantProperty,
    });
  });
});
