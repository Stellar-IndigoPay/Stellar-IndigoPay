/**
 * utils/coverage-helpers.ts
 *
 * Focused helper functions extracted for unit testability.
 * Used by the mobile Jest coverage configuration.
 */

/**
 * Convert stroops (the smallest unit of XLM) to XLM as a fixed-decimal string.
 */
export function stroopsToXLM(stroops: number): string {
  return (stroops / 10_000_000).toFixed(4);
}

/**
 * Convert XLM to stroops.
 */
export function xlmToStroops(xlm: number): number {
  return Math.round(xlm * 10_000_000);
}

/**
 * Validate a Stellar public key format (G + 55 base32 characters).
 */
export function isValidStellarAddress(addr: string): boolean {
  return /^G[A-Z2-7]{55}$/.test(addr);
}

/**
 * Validate that an address has exactly 56 characters.
 */
export function hasValidAddressLength(addr: string): boolean {
  return addr.length === 56;
}

/**
 * Estimate a Stellar transaction fee in stroops.
 */
export function estimateFee(operations: number, baseFee = 100): number {
  return baseFee * operations;
}

/**
 * Estimate a fee with safety margin.
 */
export function estimateFeeWithMargin(operations: number, baseFee = 100, margin = 1.5): number {
  return Math.ceil(baseFee * operations * margin);
}

/**
 * Calculate CO2 offset from total XLM donated.
 */
export function calculateCO2Offset(totalXLM: number, co2PerXLM = 10): number {
  return totalXLM * co2PerXLM;
}
