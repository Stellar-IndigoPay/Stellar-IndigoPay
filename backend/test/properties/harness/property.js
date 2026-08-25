"use strict";

/**
 * backend/test/properties/harness/property.js
 *
 * Minimal property-based testing runner (no external dependencies).
 *
 * `checkProperty` generates `iterations` inputs from a seeded Rng, runs the
 * predicate, and on the first failure:
 *   1. shrinks the failing input towards a minimal counterexample
 *      (structural shrink: smaller arrays, values closer to zero/empty),
 *   2. throws a PropertyFailure whose message contains the base seed, suite
 *      seed, failing iteration index and the minimal counterexample, so any
 *      CI failure can be replayed locally with:
 *
 *       PROPERTY_SEED=<base> npx jest test/properties/<file>
 */

const { resolveBaseSeed } = require("./rng");

class PropertyFailure extends Error {}

/**
 * @param {unknown} err
 * @returns {boolean} true when the predicate rejected the input
 */
async function rejectsInput(predicate, input) {
  try {
    await predicate(input);
    return false;
  } catch {
    return true;
  }
}

/**
 * Yield candidate "smaller" values for shrinking, one structural step at a
 * time. Order matters: coarse reductions first (empty/halves), then local
 * ones (drop-one, per-element/per-field).
 *
 * @param {unknown} value
 * @returns {Generator<unknown>}
 */
function* shrinkCandidates(value) {
  if (Array.isArray(value)) {
    yield [];
    const half = Math.floor(value.length / 2);
    if (value.length > 1 && half > 0) {
      yield value.slice(0, half);
      yield value.slice(half);
    }
    for (let i = 0; i < value.length; i += 1) {
      yield [...value.slice(0, i), ...value.slice(i + 1)];
    }
    for (let i = 0; i < value.length; i += 1) {
      for (const smaller of shrinkCandidates(value[i])) {
        const copy = value.slice();
        copy[i] = smaller;
        yield copy;
      }
    }
    return;
  }

  if (typeof value === "bigint") {
    if (value !== 0n) {
      yield 0n;
      const halved = value / 2n;
      if (halved !== value) yield halved;
      yield value > 0n ? value - 1n : value + 1n;
    }
    return;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value !== 0) {
      yield 0;
      const halved = Math.trunc(value / 2);
      if (halved !== value) yield halved;
      yield value > 0 ? value - 1 : value + 1;
    }
    return;
  }

  if (typeof value === "string") {
    if (value.length > 0) {
      yield "";
      yield value.slice(0, Math.floor(value.length / 2));
      yield value.slice(1);
      if (value.length > 1) yield value.slice(0, -1);
    }
    return;
  }

  if (value !== null && typeof value === "object") {
    // Shrink field values but keep the object's shape: the generated case
    // objects carry required inputs, so dropping keys would only produce
    // spurious type errors instead of meaningful counterexamples.
    for (const key of Object.keys(value)) {
      for (const smaller of shrinkCandidates(value[key])) {
        yield { ...value, [key]: smaller };
      }
    }
  }
}

/**
 * Greedy shrink to a (local) minimum: repeatedly take the first candidate
 * that still fails, until no candidate fails or the run budget is spent.
 *
 * @param {unknown} input - original failing input
 * @param {(input: unknown) => void|Promise<void>} predicate
 * @param {number} [maxPredicateRuns]
 * @returns {Promise<unknown>} minimal counterexample found
 */
async function shrink(input, predicate, maxPredicateRuns = 400) {
  let best = input;
  let runs = 0;
  let improved = true;
  while (improved && runs < maxPredicateRuns) {
    improved = false;
    for (const candidate of shrinkCandidates(best)) {
      runs += 1;
      if (runs > maxPredicateRuns) break;
      if (await rejectsInput(predicate, candidate)) {
        best = candidate;
        improved = true;
        break;
      }
    }
  }
  return best;
}

/** JSON pretty-printer that survives BigInt values. */
function pretty(value) {
  return JSON.stringify(
    value,
    (_key, v) => (typeof v === "bigint" ? `${v.toString()}n` : v),
    2,
  );
}

/**
 * Run one property.
 *
 * @param {object} opts
 * @param {string} opts.name - property name (appears in failure output)
 * @param {number} opts.seed - this suite's seed (from rng.suiteSeed)
 * @param {(rng: import("./rng").Rng, iteration: number) => unknown} opts.gen
 * @param {(input: unknown) => void|Promise<void>} opts.predicate
 *   Throws (any error) to fail the current example.
 * @param {number} [opts.iterations] - defaults to PROPERTY_ITERATIONS or 100
 * @returns {Promise<void>}
 * @throws {PropertyFailure} including seed + minimal counterexample
 */
async function checkProperty({ name, seed, gen, predicate, iterations }) {
  const {
    Rng,
    resolveIterations,
  } = require("./rng");
  const iters = iterations ?? resolveIterations();
  const rng = new Rng(seed);

  for (let i = 0; i < iters; i += 1) {
    const input = gen(rng, i);
    try {
      await predicate(input);
    } catch (originalError) {
      const minimal = await shrink(input, predicate);
      const baseSeed = resolveBaseSeed();
      throw new PropertyFailure(
        [
          `Property "${name}" FAILED`,
          `  base seed (PROPERTY_SEED): ${baseSeed}`,
          `  suite seed:                ${seed}`,
          `  failing iteration:         ${i}`,
          `  reproduce with:            PROPERTY_SEED=${baseSeed} npx jest test/properties`,
          "",
          "minimal counterexample:",
          pretty(minimal),
          "",
          `original error: ${originalError.message}`,
        ].join("\n"),
      );
    }
  }
}

module.exports = {
  PropertyFailure,
  checkProperty,
  pretty,
  shrink,
  shrinkCandidates,
};
