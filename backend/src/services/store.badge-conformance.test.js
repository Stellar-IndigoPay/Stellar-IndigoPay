"use strict";

/**
 * Badge tier conformance test (#686).
 *
 * The backend computes donor impact badges off-chain in `store.js`
 * (`computeBadges`) from cumulative XLM, while the Soroban contract computes
 * them on-chain in `lib.rs` (`calculate_badge`) from cumulative stroops. If
 * those two threshold tables ever diverge, the leaderboard would disagree
 * with the on-chain badge/NFT state.
 *
 * The Rust contract cannot be executed inside the Jest process, so this test
 * mirrors `calculate_badge` (and the `STROOP` constant) below and asserts the
 * off-chain `computeBadges` produces the equivalent tier for the same stroop
 * totals at and around every threshold boundary. If `calculate_badge` changes,
 * this mirror must change with it — which is the exact drift this test is
 * designed to catch.
 */

const { computeBadges } = require("./store");

/**
 * 1 XLM = 10_000_000 stroops.
 * Mirrors `const STROOP: i128 = 10_000_000;` in
 * `contracts/indigopay-contract/src/lib.rs`.
 */
const STROOP = 10_000_000;

/**
 * On-chain `BadgeTier` variant → off-chain `computeBadges` tier string.
 * Mirrors `BadgeTier` in `contracts/indigopay-contract/src/lib.rs`:
 * `None | Seedling | Tree | Forest | EarthGuardian`.
 *
 * `computeBadges` returns an empty array (no badge) instead of an explicit
 * "None" tier, so `None` maps to `null`.
 */
const ON_CHAIN_TO_OFF_CHAIN = {
  None: null,
  Seedling: "seedling",
  Tree: "tree",
  Forest: "forest",
  EarthGuardian: "earth",
};

/**
 * Mirror of `contracts/indigopay-contract/src/lib.rs` `calculate_badge`.
 *
 * The contract does `let xlm = total_stroops / STROOP;` — Rust `i128 / i128`
 * truncates toward zero, so `Math.trunc` mirrors it exactly for the
 * non-negative donation totals that reach this path.
 */
function calculateBadgeOnChain(totalStroops) {
  const xlm = Math.trunc(totalStroops / STROOP);
  if (xlm >= 2000) return "EarthGuardian";
  if (xlm >= 500) return "Forest";
  if (xlm >= 100) return "Tree";
  if (xlm >= 10) return "Seedling";
  return "None";
}

/**
 * Off-chain tier for a stroop total, using the same stroops → XLM conversion
 * the indexer performs (`parseFloat(stroops) / 10_000_000`, see
 * `sorobanEventService.js`) before calling `computeBadges`.
 */
function computeBadgeTierOffChain(totalStroops) {
  const totalXlm = totalStroops / STROOP;
  const earned = computeBadges(totalXlm);
  return earned.length > 0 ? earned[0].tier : null;
}

/**
 * Boundary stroop totals: each threshold, the value one stroop below it, and
 * the value one stroop below the next threshold. `onChain` is the
 * `calculate_badge` result and `offChain` is the `computeBadges` equivalent.
 */
const BOUNDARY_CASES = [
  // [totalStroops, on-chain tier, off-chain tier]
  [0, "None", null],
  [9 * STROOP + (STROOP - 1), "None", null], // 9.9999999 XLM
  [10 * STROOP, "Seedling", "seedling"], // 10 XLM
  [99 * STROOP + (STROOP - 1), "Seedling", "seedling"], // 99.9999999 XLM
  [100 * STROOP, "Tree", "tree"], // 100 XLM
  [499 * STROOP + (STROOP - 1), "Tree", "tree"], // 499.9999999 XLM
  [500 * STROOP, "Forest", "forest"], // 500 XLM
  [1999 * STROOP + (STROOP - 1), "Forest", "forest"], // 1999.9999999 XLM
  [2000 * STROOP, "EarthGuardian", "earth"], // 2000 XLM
  [50_000 * STROOP, "EarthGuardian", "earth"], // well above the top tier
];

describe("badge tier conformance: computeBadges ↔ calculate_badge (#686)", () => {
  test.each(BOUNDARY_CASES)(
    "%d stroops → on-chain %s / off-chain %s",
    (totalStroops, onChainTier, offChainTier) => {
      expect(calculateBadgeOnChain(totalStroops)).toBe(onChainTier);
      expect(computeBadgeTierOffChain(totalStroops)).toBe(offChainTier);
    },
  );

  test("agrees with the on-chain calculation at every XLM and stroop boundary up to 2100 XLM", () => {
    for (let xlm = 0; xlm <= 2100; xlm += 1) {
      const exact = xlm * STROOP;
      expect(computeBadgeTierOffChain(exact)).toBe(
        ON_CHAIN_TO_OFF_CHAIN[calculateBadgeOnChain(exact)],
      );

      // One stroop below each XLM boundary catches the classic off-by-one
      // where one side rounds and the other truncates.
      if (exact > 0) {
        const oneStroopBelow = exact - 1;
        expect(computeBadgeTierOffChain(oneStroopBelow)).toBe(
          ON_CHAIN_TO_OFF_CHAIN[calculateBadgeOnChain(oneStroopBelow)],
        );
      }
    }
  });

  test("off-chain returns a single highest tier, never an on-chain None badge", () => {
    for (const [totalStroops, onChainTier] of BOUNDARY_CASES) {
      const earned = computeBadges(totalStroops / STROOP);
      expect(earned.length).toBeLessThanOrEqual(1);
      if (onChainTier === "None") {
        expect(earned).toEqual([]);
      }
    }
  });
});
