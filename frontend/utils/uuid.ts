/**
 * Safe client-side random UUID generator with a fallback for non-secure contexts and older browsers.
 */
export function safeRandomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const getRandByte = (): number => {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const arr = new Uint8Array(1);
      crypto.getRandomValues(arr);
      return arr[0];
    }
    return Math.floor(Math.random() * 256);
  };

  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
    const num = parseInt(c, 10);
    return (num ^ (getRandByte() & (15 >> (num / 4)))).toString(16);
  });
}
