declare module 'secrets.js-grempe' {
  export function share(secret: string, numShares: number, threshold: number, padLength?: number): string[];
  export function combine(shares: string[]): string;
  export function init(bits: number): void;
  export function setRNG(rng: () => number | string): void;
}
