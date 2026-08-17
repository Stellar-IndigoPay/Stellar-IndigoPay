export const STROOPS_PER_XLM = BigInt(1_000_000);

/**
 * Converts a decimal XLM string into the exact integer stroop count used by
 * Stellar. This avoids JavaScript floating-point rounding entirely.
 *
 * Accepts strings such as "0.1", "1", "1.234567", and "0.0000010".
 * Rejects invalid inputs and amounts with more than 6 significant decimal
 * places (sub-stroop precision), because 1 stroop = 0.000001 XLM.
 */
export function xlmToStroops(amount: string): bigint {
  const value = amount.trim();

  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error("Invalid XLM amount");
  }

  const [wholePart, fractionalPart = ""] = value.split(".");
  const normalizedFraction = fractionalPart.replace(/0+$/, "");

  if (normalizedFraction.length > 6) {
    throw new Error("XLM amount must not exceed 6 decimal places");
  }

  const whole = BigInt(wholePart || "0");
  if (normalizedFraction.length === 0) {
    return whole * STROOPS_PER_XLM;
  }

  const fraction = BigInt(normalizedFraction.padEnd(6, "0"));
  return whole * STROOPS_PER_XLM + fraction;
}

export function isValidXlmAmount(amount: string): boolean {
  try {
    return xlmToStroops(amount) > BigInt(0);
  } catch {
    return false;
  }
}
