/**
 * utils/format.ts
 * Formatting helpers and small UI-friendly utilities shared across the frontend.
 */
import { formatDistanceToNow } from "date-fns";
import type { ProjectStatus, BadgeTier } from "./types";

/**
 * Locale pinned for all locale-aware formatting. Server-rendered and
 * client-hydrated output must never depend on the environment's default
 * locale, so every `Intl.*` call passes an explicit locale.
 */
export const PINNED_LOCALE = "en-US";

/**
 * Timezone pinned for all date/time formatting. Using UTC keeps SSR output
 * deterministic regardless of the server's or the browser's local timezone,
 * preventing React hydration mismatches and flickering values.
 */
export const PINNED_TIME_ZONE = "UTC";

/**
 * Format a number using Intl.NumberFormat according to the specified locale.
 *
 * The locale defaults to {@link PINNED_LOCALE} so output is identical on the
 * server and the client instead of following each environment's default.
 *
 * @param value - Number to format.
 * @param locale - Locale string (default: PINNED_LOCALE).
 * @param options - Optional Intl.NumberFormatOptions.
 * @returns Formatted number string.
 */
export function formatNumber(
  value: number,
  locale: string = PINNED_LOCALE,
  options: Intl.NumberFormatOptions = {}
): string {
  return new Intl.NumberFormat(locale, options).format(value);
}

/**
 * Format an amount as XLM with locale separators.
 *
 * @param amount - Amount in XLM (string or number).
 * @param decimalsOrLocale - Maximum fractional digits or locale string.
 * @param locale - Locale string if decimals is passed as second arg (default: PINNED_LOCALE).
 * @returns Formatted string like `"1,234.56 XLM"`.
 */
export function formatXLM(
  amount: string | number,
  decimalsOrLocale: number | string = 2,
  locale: string = PINNED_LOCALE
): string {
  let decimals = 2;
  let loc = PINNED_LOCALE;
  if (typeof decimalsOrLocale === "number") {
    decimals = decimalsOrLocale;
    loc = locale;
  } else if (typeof decimalsOrLocale === "string") {
    loc = decimalsOrLocale;
  }
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(n)) return "0 XLM";
  return (
    new Intl.NumberFormat(loc, {
      minimumFractionDigits: 0,
      maximumFractionDigits: decimals,
    }).format(n) + " XLM"
  );
}

/**
 * Convert an XLM amount into an approximate USD string.
 *
 * @param xlmAmount - Amount in XLM.
 * @param price - Current XLM→USD price; when `null`, no estimate is returned.
 * @returns A string like `"≈ $12.34 USD"` or `null` if not available.
 * @throws {Error} Never throws; returns `null` for invalid inputs.
 */
export function formatUSDEquivalent(
  xlmAmount: string | number,
  price: number | null,
): string | null {
  if (price === null) return null;
  const n = typeof xlmAmount === "string" ? parseFloat(xlmAmount) : xlmAmount;
  if (isNaN(n)) return null;
  const usd = n * price;
  return `≈ $${formatNumber(usd, PINNED_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} USD`;
}

/**
 * Format a CO₂ amount (in kilograms) into a compact human-readable string.
 *
 * @param kg - CO₂ offset in kilograms.
 * @returns A string like `"850 kg CO₂"`, `"1.2k kg CO₂"`, or `"3.4M kg CO₂"`.
 * @throws {Error} Never throws.
 *
 * @example
 * formatCO2(850) // "850 kg CO₂"
 * @example
 * formatCO2(1200) // "1.2k kg CO₂"
 */
export function formatCO2(kg: number): string {
  if (kg >= 1_000_000) return `${(kg / 1_000_000).toFixed(1)}M kg CO₂`;
  if (kg >= 1_000) return `${(kg / 1_000).toFixed(1)}k kg CO₂`;
  return `${formatNumber(kg)} kg CO₂`;
}

/**
 * Calculate fundraising progress percent.
 *
 * @param raised - Raised XLM amount (string).
 * @param goal - Goal XLM amount (string).
 * @returns Integer percent between 0 and 100.
 * @throws {Error} Never throws; returns `0` when inputs are invalid.
 *
 * @example
 * progressPercent("50", "200") // 25
 * @example
 * progressPercent("9999", "100") // 100
 */
export function progressPercent(raised: string, goal: string): number {
  const r = parseFloat(raised),
    g = parseFloat(goal);
  if (!g || isNaN(r) || isNaN(g)) return 0;
  return Math.min(100, Math.round((r / g) * 100));
}

/**
 * Convert an ISO date string to a relative time (e.g. "3 days ago").
 *
 * @param d - ISO date string.
 * @returns Relative time string, or the original input on failure.
 * @throws {Error} Never throws.
 */
export function timeAgo(d: string): string {
  try {
    return formatDistanceToNow(new Date(d), { addSuffix: true });
  } catch {
    return d;
  }
}

/**
 * Format an ISO date string as "MMM d, yyyy" (e.g. "Aug 15, 2026").
 *
 * The locale and timezone are pinned ({@link PINNED_LOCALE}, {@link PINNED_TIME_ZONE})
 * so server-rendered and client-hydrated output is identical even when the
 * server and browser resolve different default locales/timezones.
 *
 * @param d - ISO date string.
 * @param locale - Locale string (default: PINNED_LOCALE).
 * @param timeZone - IANA timezone (default: PINNED_TIME_ZONE).
 * @param options - Optional Intl.DateTimeFormatOptions merged over the defaults.
 * @returns Formatted date string, or the original input on failure.
 * @throws {Error} Never throws.
 */
export function formatDate(
  d: string,
  locale: string = PINNED_LOCALE,
  timeZone: string = PINNED_TIME_ZONE,
  options: Intl.DateTimeFormatOptions = {}
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone,
      ...options,
    }).format(new Date(d));
  } catch {
    return d;
  }
}

/**
 * Format an ISO date string as a medium date + short time (e.g. "Aug 15, 2026, 11:30 PM").
 *
 * Uses the pinned locale/timezone for deterministic SSR output.
 *
 * @param d - ISO date string.
 * @param locale - Locale string (default: PINNED_LOCALE).
 * @param timeZone - IANA timezone (default: PINNED_TIME_ZONE).
 * @returns Formatted date-time string, or the original input on failure.
 * @throws {Error} Never throws.
 */
export function formatDateTime(
  d: string,
  locale: string = PINNED_LOCALE,
  timeZone: string = PINNED_TIME_ZONE
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    }).format(new Date(d));
  } catch {
    return d;
  }
}

/**
 * Format an ISO date string as a short time (e.g. "11:30 PM").
 *
 * Uses the pinned locale/timezone for deterministic SSR output.
 *
 * @param d - ISO date string.
 * @param locale - Locale string (default: PINNED_LOCALE).
 * @param timeZone - IANA timezone (default: PINNED_TIME_ZONE).
 * @returns Formatted time string, or the original input on failure.
 * @throws {Error} Never throws.
 */
export function formatTime(
  d: string,
  locale: string = PINNED_LOCALE,
  timeZone: string = PINNED_TIME_ZONE
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      timeStyle: "short",
      timeZone,
    }).format(new Date(d));
  } catch {
    return d;
  }
}

/**
 * Format a date as a long month + numeric year (e.g. "August 2026").
 *
 * Uses the pinned locale/timezone for deterministic SSR output.
 *
 * @param d - ISO date string or Date object.
 * @param locale - Locale string (default: PINNED_LOCALE).
 * @param timeZone - IANA timezone (default: PINNED_TIME_ZONE).
 * @returns Formatted month-year string, or the original input on failure.
 * @throws {Error} Never throws.
 */
export function formatMonthYear(
  d: string | Date,
  locale: string = PINNED_LOCALE,
  timeZone: string = PINNED_TIME_ZONE
): string {
  try {
    return new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone,
    }).format(d instanceof Date ? d : new Date(d));
  } catch {
    return typeof d === "string" ? d : String(d);
  }
}

/**
 * Shorten a Stellar address to `prefix...suffix`.
 *
 * @param address - Full address string.
 * @param chars - Number of characters to keep at both ends.
 * @returns Shortened address.
 * @throws {Error} Never throws.
 */
export function shortenAddress(address: string, chars = 6): string {
  if (!address || address.length < chars * 2) return address;
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}

/**
 * Copy a string to the user's clipboard.
 *
 * @param text - Text to copy.
 * @returns `true` on success, `false` on failure.
 * @throws {Error} Never throws; errors are caught and return `false`.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Map a project status to a CSS class used by status badges.
 *
 * @param s - Project status.
 * @returns Tailwind/CSS class name.
 * @throws {Error} Never throws.
 */
export function statusClass(s: ProjectStatus): string {
  return (
    {
      active: "badge-active",
      completed: "badge-complete",
      paused: "badge-paused",
      rejected: "badge-paused",
    }[s] ?? "badge-paused"
  );
}

/**
 * Map a project status to a human-readable label.
 *
 * @param s - Project status.
 * @returns Label string.
 * @throws {Error} Never throws.
 */
export function statusLabel(s: ProjectStatus): string {
  return (
    {
      active: "Active",
      completed: "Completed",
      paused: "Paused",
      rejected: "Rejected",
    }[s] ?? "Unknown"
  );
}

/**
 * Map a badge tier to its emoji representation.
 *
 * @param tier - Badge tier.
 * @returns Emoji string.
 * @throws {Error} Never throws.
 *
 * @example
 * badgeEmoji("seedling") // "🌱"
 * @example
 * badgeEmoji("earth") // "🌍"
 */
export function badgeEmoji(tier: BadgeTier): string {
  return { seedling: "🌱", tree: "🌳", forest: "🌲", earth: "🌍" }[tier];
}

/**
 * Map a badge tier to a display label.
 *
 * @param tier - Badge tier.
 * @returns Label string.
 * @throws {Error} Never throws.
 */
export function badgeLabel(tier: BadgeTier): string {
  return {
    seedling: "Seedling",
    tree: "Tree",
    forest: "Forest",
    earth: "Earth Guardian",
  }[tier];
}

/**
 * Minimum donation threshold (in XLM) for a badge tier.
 *
 * @param tier - Badge tier.
 * @returns Threshold in XLM.
 * @throws {Error} Never throws.
 */
export function badgeThreshold(tier: BadgeTier): number {
  return { seedling: 10, tree: 100, forest: 500, earth: 2000 }[tier];
}

/**
 * List of known project categories used by the UI.
 *
 * @returns An array of category names.
 * @throws {Error} Never throws.
 */
export const PROJECT_CATEGORIES = [
  "Reforestation",
  "Solar Energy",
  "Ocean Conservation",
  "Clean Water",
  "Wildlife Protection",
  "Carbon Capture",
  "Wind Energy",
  "Sustainable Agriculture",
  "Other",
];

/**
 * Mapping from category name to an emoji icon used in the UI.
 *
 * @returns Record of category to emoji.
 * @throws {Error} Never throws.
 */
export const CATEGORY_ICONS: Record<string, string> = {
  Reforestation: "🌳",
  "Solar Energy": "☀️",
  "Ocean Conservation": "🌊",
  "Clean Water": "💧",
  "Wildlife Protection": "🦁",
  "Carbon Capture": "♻️",
  "Wind Energy": "💨",
  "Sustainable Agriculture": "🌾",
  Other: "🌿",
};

/**
 * Calculate a donor's monthly donation streak.
 *
 * @param donations - Donations with `createdAt` timestamps.
 * @returns Current streak and longest streak (in months).
 * @throws {Error} Never throws.
 */
export function calculateStreak(donations: { createdAt: string }[]): {
  current: number;
  longest: number;
} {
  if (donations.length === 0) return { current: 0, longest: 0 };

  // Group by month (YYYY-MM)
  const months = Array.from(
    new Set(
      donations.map((d) => {
        const date = new Date(d.createdAt);
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      }),
    ),
  )
    .sort()
    .reverse(); // Newest first

  if (months.length === 0) return { current: 0, longest: 0 };

  let currentStreak = 0;
  const now = new Date();
  const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthStr = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;

  // Check if donor donated this month or last month to maintain current streak
  if (months[0] === currentMonth || months[0] === lastMonthStr) {
    let checkDate = new Date(now.getFullYear(), now.getMonth(), 1);
    if (months[0] !== currentMonth) {
      checkDate.setMonth(checkDate.getMonth() - 1);
    }

    for (let i = 0; i < months.length; i++) {
      const mStr = `${checkDate.getFullYear()}-${String(checkDate.getMonth() + 1).padStart(2, "0")}`;
      if (months.includes(mStr)) {
        currentStreak++;
        checkDate.setMonth(checkDate.getMonth() - 1);
      } else {
        break;
      }
    }
  }

  // Calculate longest streak
  let longest = 0;
  let tempStreak = 0;
  const allMonths = [...months].reverse(); // Oldest first

  for (let i = 0; i < allMonths.length; i++) {
    if (i === 0) {
      tempStreak = 1;
    } else {
      const prevDate = new Date(allMonths[i - 1] + "-01");
      const currDate = new Date(allMonths[i] + "-01");
      const diff =
        (currDate.getFullYear() - prevDate.getFullYear()) * 12 +
        (currDate.getMonth() - prevDate.getMonth());

      if (diff === 1) {
        tempStreak++;
      } else {
        tempStreak = 1;
      }
    }
    longest = Math.max(longest, tempStreak);
  }

  return { current: currentStreak, longest };
}
