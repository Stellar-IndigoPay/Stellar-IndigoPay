"use strict";

/**
 * backend/test/properties/harness/rng.js
 *
 * Deterministic pseudo-random number generator for the property-based test
 * suites. Deliberately avoids Math.random() and crypto RNGs so a failing
 * seed replays byte-for-byte on any Node version and platform: mulberry32 is
 * built only from operations whose semantics are fixed by the ECMAScript
 * spec (Math.imul, |, >>>), unlike Math.random() which is engine-defined.
 *
 * Seed strategy (see ../README.md):
 *   - CI runs with fixed seeds (PROPERTY_SEED unset -> DEFAULT_BASE_SEED).
 *   - PROPERTY_SEED=<n> overrides the base seed; every suite derives its own
 *     seed deterministically from the base (`suiteSeed`), so one env var
 *     reproduces an entire failed run.
 *   - The nightly workflow passes a fresh date-derived seed and logs it.
 */

const DEFAULT_BASE_SEED = 20260824;
const DEFAULT_ITERATIONS = 100;

/**
 * mulberry32 PRNG. Returns floats in [0, 1).
 * Reference: https://en.wikipedia.org/wiki/Mulberry32
 *
 * @param {number} a - 32-bit seed
 * @returns {() => number}
 */
function mulberry32(a) {
  let state = a | 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Rng {
  /**
   * @param {number} seed - 32-bit unsigned integer
   */
  constructor(seed) {
    this.seed = seed >>> 0;
    this.nextFloat = mulberry32(this.seed);
  }

  /** Uniform unsigned 32-bit integer. */
  uint32() {
    return Math.floor(this.nextFloat() * 4294967296) % 4294967296;
  }

  /** Uniform integer in [min, max] (inclusive). */
  int(min, max) {
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /** True with probability p. */
  bool(p = 0.5) {
    return this.nextFloat() < p;
  }

  chance(p) {
    return this.bool(p);
  }

  /** Uniform non-negative BigInt with at most `bits` bits. */
  bigInt(bits) {
    let out = 0n;
    for (let remaining = bits; remaining > 0; remaining -= 32) {
      out = (out << 32n) | BigInt(this.uint32());
    }
    return out;
  }

  pick(items) {
    return items[this.int(0, items.length - 1)];
  }

  /** Fisher-Yates shuffle of a copy. */
  shuffle(items) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

/**
 * Base seed for this run: PROPERTY_SEED when set (CI/nightly/replay),
 * otherwise the fixed default so plain `npm test` is deterministic.
 *
 * @returns {number}
 */
function resolveBaseSeed() {
  const raw = process.env.PROPERTY_SEED;
  if (raw === undefined || raw === "") return DEFAULT_BASE_SEED;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(
      `PROPERTY_SEED must be a non-negative integer, got: "${raw}"`,
    );
  }
  return parsed >>> 0;
}

/**
 * Iterations per property: PROPERTY_ITERATIONS when set, else the CI default.
 * The nightly workflow sets a much higher value.
 *
 * @param {number} [defaultIterations]
 * @returns {number}
 */
function resolveIterations(defaultIterations = DEFAULT_ITERATIONS) {
  const raw = process.env.PROPERTY_ITERATIONS;
  if (raw === undefined || raw === "") return defaultIterations;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100000) {
    throw new Error(
      `PROPERTY_ITERATIONS must be an integer in [1, 100000], got: "${raw}"`,
    );
  }
  return parsed;
}

/**
 * Deterministic per-suite seed derived from the base seed, so suites do not
 * all consume identical input streams while remaining reproducible from the
 * single PROPERTY_SEED knob.
 *
 * @param {number} suiteOrdinal - distinct small integer per suite/space
 * @returns {number}
 */
function suiteSeed(suiteOrdinal) {
  return (resolveBaseSeed() + suiteOrdinal * 7919) >>> 0;
}

module.exports = {
  DEFAULT_BASE_SEED,
  DEFAULT_ITERATIONS,
  Rng,
  mulberry32,
  resolveBaseSeed,
  resolveIterations,
  suiteSeed,
};
