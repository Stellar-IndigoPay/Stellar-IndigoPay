/**
 * Seeded pseudo-random number generator (mulberry32).
 *
 * Deterministic: same seed → same sequence every time, across Node and browser.
 * No external dependencies. Suitable for test fixture generation only.
 */

export interface SeededRNG {
  /** Returns a float in [0, 1). */
  next(): number;
  /** Returns an integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** Returns a float in [min, max). */
  float(min: number, max: number): number;
  /** Picks a random element from the array. */
  pick<T>(arr: T[]): T;
  /** Returns a new RNG forked from this one (independent sequence). */
  fork(): SeededRNG;
}

function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a seeded RNG from a numeric seed.
 *
 * @param seed - Any integer. Default 42.
 */
export function createRNG(seed: number = 42): SeededRNG {
  const next = mulberry32(seed);

  return {
    next() {
      return next();
    },
    int(min: number, max: number): number {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    float(min: number, max: number): number {
      return next() * (max - min) + min;
    },
    pick<T>(arr: T[]): T {
      if (arr.length === 0) throw new RangeError("pick() called with empty array");
      return arr[Math.floor(next() * arr.length)];
    },
    fork(): SeededRNG {
      // Fork by consuming 32 values and using the next as a new seed
      let forkSeed = 0;
      for (let i = 0; i < 32; i++) {
        forkSeed = (forkSeed + Math.floor(next() * 2147483647)) | 0;
      }
      return createRNG(forkSeed);
    },
  };
}
