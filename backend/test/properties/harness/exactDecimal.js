"use strict";

/**
 * backend/test/properties/harness/exactDecimal.js
 *
 * Independent exact decimal -> scaled-BigInt conversion used as the ORACLE
 * side of projection property assertions. Deliberately NOT imported from
 * src/services/projectionEngine.js: if the production converter regressed,
 * an oracle built on top of it would silently agree with the bug. This
 * implementation is ~15 lines of string math with no shared code path.
 */

/**
 * Convert a plain decimal string ("123", "1.25", "-0.007") to
 * BigInt(value * 10^scale), truncating extra fractional digits.
 *
 * @param {string} value - plain decimal string (sign, digits, optional point)
 * @param {number} scale
 * @returns {bigint}
 */
function toScaled(value, scale) {
  let s = String(value).trim();
  if (s === "") return 0n;
  const negative = s.startsWith("-");
  if (negative || s.startsWith("+")) s = s.slice(1);
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(scale)).slice(0, scale);
  const out =
    BigInt(intPart === "" ? "0" : intPart) * 10n ** BigInt(scale) +
    BigInt(frac === "" ? "0" : frac);
  return negative ? -out : out;
}

/**
 * Exact sum of decimal strings at a fixed scale.
 *
 * @param {string[]} values
 * @param {number} scale
 * @returns {bigint}
 */
function sumScaled(values, scale) {
  let total = 0n;
  for (const v of values) total += toScaled(v, scale);
  return total;
}

module.exports = { sumScaled, toScaled };
