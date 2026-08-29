/** Shared donation-preset storage, normalization, and keyboard helpers. */

export const PRESET_COUNT = 4;
export const MIN_DONATION_XLM = 0.1;

export type DonationPresets = [string, string, string, string];

export const DEFAULT_DONATION_PRESETS: DonationPresets = [
  "1",
  "5",
  "10",
  "50",
];

export function parseDonationAmount(value: unknown): number | null {
  const text =
    typeof value === "string"
      ? value.trim()
      : typeof value === "number" && Number.isFinite(value)
        ? String(value)
        : "";
  if (!text) return null;

  const amount = Number(text);
  if (!Number.isFinite(amount) || amount < MIN_DONATION_XLM) return null;
  return amount;
}

export function isValidDonationAmount(value: unknown): boolean {
  return parseDonationAmount(value) !== null;
}

function normalizePresetAmount(value: unknown, fallback: string): string {
  const amount = parseDonationAmount(value);
  return amount === null ? fallback : String(value).trim();
}

/** Normalize malformed or partial sync storage without throwing. */
export function normalizeDonationPresets(value: unknown): DonationPresets {
  const stored = Array.isArray(value) ? value : [];
  return DEFAULT_DONATION_PRESETS.map((fallback, index) =>
    normalizePresetAmount(stored[index], fallback),
  ) as DonationPresets;
}

/** Load only the shared preset setting for content-script/overlay consumers. */
export function loadDonationPresets(): Promise<DonationPresets> {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["donationPresets"], (items: { [key: string]: unknown }) => {
      resolve(normalizeDonationPresets(items?.donationPresets));
    });
  });
}

export function presetIndexForAmount(
  amount: unknown,
  presets: readonly string[],
): number {
  const numericAmount = parseDonationAmount(amount);
  if (numericAmount === null) return -1;
  return presets.findIndex((preset) => Number(preset) === numericAmount);
}

/** Return the zero-based preset index for Ctrl+1 through Ctrl+4. */
export function presetIndexForShortcut(
  event: Pick<KeyboardEvent, "ctrlKey" | "key">,
): number {
  if (!event.ctrlKey || !/^[1-4]$/.test(event.key)) return -1;
  return Number(event.key) - 1;
}
