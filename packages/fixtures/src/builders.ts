/**
 * Typed fixture builders for Stellar-IndigoPay domain objects.
 *
 * Every builder accepts optional overrides — fields not specified are
 * filled from the seeded RNG so output is deterministic for a given seed.
 */

import { createRNG, type SeededRNG } from "./rng";
import type {
  Project,
  Donation,
  DonationMatch,
  Profile,
  Campaign,
  Milestone,
  ProjectUpdate,
  QueueItem,
  TimelineEntry,
} from "./types";

// ── Helpers ───────────────────────────────────────────────────────────

const CATEGORIES = [
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

const STATUSES: Project["status"][] = ["active", "completed", "paused", "rejected"];

const PROJECT_NAMES = [
  "Amazon Reforestation Initiative",
  "Pacific Solar Farm",
  "Coral Reef Restoration Project",
  "Clean Water for Rural Communities",
  "African Elephant Sanctuary",
  "Direct Air Capture Facility",
  "Offshore Wind Array",
  "Regenerative Agriculture Co-op",
  "Mangrove Conservation Program",
  "Sahel Greenbelt Project",
];

const LOCATIONS = [
  "Brazil",
  "Kenya",
  "Indonesia",
  "India",
  "Costa Rica",
  "Philippines",
  "Morocco",
  "Peru",
  "Tanzania",
  "Colombia",
];

const MESSAGES = [
  "Keep up the great work!",
  "Happy to support this cause.",
  "For the planet 🌍",
  null,
  null,
  "Thanks for making a difference.",
  null,
];

/**
 * Generate a hex string of the given byte length (e.g., 32 bytes → 64 hex chars).
 */
function randomHex(rng: SeededRNG, byteLength: number): string {
  let hex = "";
  for (let i = 0; i < byteLength * 2; i++) {
    hex += rng.int(0, 15).toString(16);
  }
  return hex;
}

/**
 * Generate a deterministic UUID v4 string.
 */
function randomUUID(rng: SeededRNG): string {
  const hex = randomHex(rng, 16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${rng.pick(["8", "9", "a", "b"])}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ── Stellar StrKey helpers ────────────────────────────────────────────

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * CRC16-XMODEM as used by Stellar StrKey encoding.
 */
function crc16Xmodem(data: Uint8Array): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc & 0xffff;
}

/**
 * Encode a byte array as base32 (no padding, per RFC 4648 §7).
 */
function encodeBase32(bytes: Uint8Array): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += BASE32_ALPHABET[(value >> bits) & 31];
    }
  }
  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return result;
}

/**
 * Generate a deterministic Stellar ed25519 public key with a valid
 * StrKey CRC16-XMODEM checksum (G + 55 base32 chars = 56 total).
 */
function randomStellarKey(rng: SeededRNG): string {
  const VERSION_BYTE = 0x30; // ed25519 public key
  const payload = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    payload[i] = rng.int(0, 255);
  }

  // version + payload = 33 bytes, then append 2-byte CRC = 35 bytes → 56 base32 chars
  const versionAndPayload = new Uint8Array(33);
  versionAndPayload[0] = VERSION_BYTE;
  versionAndPayload.set(payload, 1);

  const crc = crc16Xmodem(versionAndPayload);
  const full = new Uint8Array(35);
  full.set(versionAndPayload);
  full[33] = (crc >> 8) & 0xff;
  full[34] = crc & 0xff;

  return encodeBase32(full);
}

/**
 * Format a number as a decimal string (e.g., 1234567 → "1234567").
 */
function formatXLM(value: number): string {
  return value.toFixed(7).replace(/\.?0+$/, "") || "0";
}

/**
 * Produce a deterministic ISO-8601 date string from a seed.
 * The epoch is anchored to 2026-01-01T00:00:00Z and offsets by 0..364 days + 0..86399 seconds.
 */
function seededDate(rng: SeededRNG): string {
  const EPOCH_MS = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00.000Z
  const dayOffset = rng.int(0, 364);
  const secOffset = rng.int(0, 86399);
  const ms = EPOCH_MS + dayOffset * 86400000 + secOffset * 1000;
  return new Date(ms).toISOString();
}

/**
 * Produce a deterministic ISO-8601 date string that is at or after the
 * given base date by a non-negative offset of 0..3600 seconds.
 */
function seededDateAfter(rng: SeededRNG, baseDate: string): string {
  const baseMs = new Date(baseDate).getTime();
  const offsetSec = rng.int(0, 3600);
  return new Date(baseMs + offsetSec * 1000).toISOString();
}

// ── Strip internal-only keys (seed) before returning ──────────────────

function stripSeed<T extends Record<string, unknown>>(obj: T): T {
  const { seed: _seed, ...rest } = obj as any;
  return rest;
}

// ── Builders ──────────────────────────────────────────────────────────

export interface ProjectOverrides extends Partial<Omit<Project, "id" | "createdAt" | "updatedAt">> {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic Project fixture.
 *
 * @example
 * ```ts
 * const p = project({ name: "My Project", seed: 42 });
 * ```
 */
export function project(overrides: ProjectOverrides = {}): Project {
  const baseSeed = overrides.seed ?? (
    overrides.id
      ? hashString(overrides.id)
      : overrides.name
        ? hashString(overrides.name)
        : 42
  );
  const rng = createRNG(baseSeed);

  // Generate RNG-driven values first
  const raised = rng.float(0, 50000);
  const goal = Math.max(raised, rng.float(10000, 200000));

  const now = seededDate(rng);

  // Build base object, then apply overrides
  const base = {
    id: randomUUID(rng),
    name: rng.pick(PROJECT_NAMES),
    description: `A climate project focused on ${rng.pick(CATEGORIES).toLowerCase()} initiatives.`,
    category: rng.pick(CATEGORIES),
    location: rng.pick(LOCATIONS),
    walletAddress: randomStellarKey(rng),
    goalXLM: formatXLM(goal),
    raisedXLM: formatXLM(raised),
    donorCount: rng.int(10, 5000),
    co2OffsetKg: rng.int(100, 100000),
    status: "active" as Project["status"],
    rejectionReason: null as string | null,
    verified: true,
    onChainVerified: rng.pick([true, false]),
    tags: [rng.pick(CATEGORIES).toLowerCase()],
    aiSummary: null as string | null,
    aiSummaryGeneratedAt: null as string | null,
    aiSummaryModel: null as string | null,
    aiSummarySourceHash: null as string | null,
    createdAt: now,
    updatedAt: now,
  };

  // Apply caller overrides on top of defaults
  const merged = { ...base, ...stripSeed(overrides as any) };

  // Recompute dependent fields from final source values
  const raisedFinal = parseFloat(merged.raisedXLM);
  const goalFinal = parseFloat(merged.goalXLM);
  if (goalFinal < raisedFinal) {
    merged.goalXLM = formatXLM(raisedFinal);
  }

  // Ensure updatedAt >= createdAt
  if (new Date(merged.updatedAt).getTime() < new Date(merged.createdAt).getTime()) {
    merged.updatedAt = seededDateAfter(createRNG(rng.int(1, 100000)), merged.createdAt);
  }

  return merged;
}

export interface DonationOverrides extends Partial<Omit<Donation, "id" | "createdAt">> {
  id?: string;
  createdAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic Donation fixture.
 */
export function donation(overrides: DonationOverrides = {}): Donation {
  const baseSeed = overrides.seed ?? (overrides.id ? hashString(overrides.id) : 100);
  const rng = createRNG(baseSeed);

  const amountXLM = overrides.amountXLM
    ? parseFloat(overrides.amountXLM)
    : rng.float(1, 500);

  const now = seededDate(rng);

  const base: Donation = {
    id: randomUUID(rng),
    projectId: randomUUID(rng),
    donorAddress: randomStellarKey(rng),
    amount: formatXLM(amountXLM),
    amountXLM: formatXLM(amountXLM),
    currency: "XLM",
    message: rng.pick(MESSAGES),
    transactionHash: randomHex(rng, 32),
    createdAt: now,
    anonymous: false,
    receiptGeneratedAt: null,
  };

  return { ...base, ...stripSeed(overrides as any) };
}

export interface MatchOverrides extends Partial<Omit<DonationMatch, "id" | "createdAt">> {
  id?: string;
  createdAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic DonationMatch fixture.
 */
export function match(overrides: MatchOverrides = {}): DonationMatch {
  const baseSeed = overrides.seed ?? (overrides.id ? hashString(overrides.id) : 200);
  const rng = createRNG(baseSeed);

  const cap = overrides.capXLM ? parseFloat(overrides.capXLM) : rng.float(100, 10000);
  const multiplier = overrides.multiplier ?? rng.pick([1, 1.5, 2, 3]);
  const matched = rng.float(0, cap);

  const now = seededDate(rng);
  const daysOffset = rng.int(1, 30);
  const expiresMs = new Date(now).getTime() + daysOffset * 86400000;
  const expires = new Date(expiresMs).toISOString();

  const base: DonationMatch = {
    id: randomUUID(rng),
    projectId: randomUUID(rng),
    matcherAddress: randomStellarKey(rng),
    capXLM: formatXLM(cap),
    multiplier,
    matchedXLM: formatXLM(matched),
    remainingXLM: formatXLM(Math.max(0, cap - matched)),
    expiresAt: expires,
    createdAt: now,
  };

  // Apply overrides, then recompute remainingXLM from final cap and matched
  const merged = { ...base, ...stripSeed(overrides as any) };
  const finalCap = parseFloat(merged.capXLM);
  const finalMatched = parseFloat(merged.matchedXLM);
  merged.remainingXLM = formatXLM(Math.max(0, finalCap - finalMatched));

  return merged;
}

export interface ProfileOverrides extends Partial<Omit<Profile, "publicKey" | "createdAt" | "updatedAt">> {
  publicKey?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic Profile fixture.
 */
export function profile(overrides: ProfileOverrides = {}): Profile {
  const baseSeed = overrides.seed ?? (overrides.publicKey ? hashString(overrides.publicKey) : 300);
  const rng = createRNG(baseSeed);

  const now = seededDate(rng);

  const base: Profile = {
    publicKey: randomStellarKey(rng),
    displayName: rng.pick(["Alice", "Bob", "Carol", "Dave", "Eve"]),
    bio: "Climate enthusiast and donor.",
    totalDonatedXLM: formatXLM(rng.float(10, 5000)),
    projectsSupported: rng.int(1, 20),
    badges: [
      { tier: rng.pick(["bronze", "silver", "gold"]), earnedAt: now },
    ],
    createdAt: now,
    updatedAt: now,
  };

  const merged = { ...base, ...stripSeed(overrides as any) };

  // Ensure updatedAt >= createdAt
  if (new Date(merged.updatedAt).getTime() < new Date(merged.createdAt).getTime()) {
    merged.updatedAt = seededDateAfter(createRNG(rng.int(1, 100000)), merged.createdAt);
  }

  return merged;
}

export interface CampaignOverrides extends Partial<Omit<Campaign, "id" | "createdAt">> {
  id?: string;
  createdAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic Campaign fixture.
 */
export function campaign(overrides: CampaignOverrides = {}): Campaign {
  const baseSeed = overrides.seed ?? (overrides.id ? hashString(overrides.id) : 400);
  const rng = createRNG(baseSeed);

  const goal = rng.float(1000, 100000);
  const raised = rng.float(0, goal);
  const now = seededDate(rng);
  const daysOffset = rng.int(7, 90);
  const deadlineMs = new Date(now).getTime() + daysOffset * 86400000;
  const deadline = new Date(deadlineMs).toISOString();

  const base: Campaign = {
    id: randomUUID(rng),
    projectId: randomUUID(rng),
    title: rng.pick(["Tree Planting Drive", "Solar Panel Fund", "Ocean Cleanup", "Water Well Project"]),
    description: "Help fund this campaign.",
    goalXLM: formatXLM(goal),
    raisedXLM: formatXLM(raised),
    deadline,
    progressPercent: Math.round((raised / goal) * 100),
    completed: raised >= goal,
    active: true,
    createdAt: now,
  };

  // Apply overrides, then recompute dependent fields from final values
  const merged = { ...base, ...stripSeed(overrides as any) };
  const finalGoal = parseFloat(merged.goalXLM);
  const finalRaised = parseFloat(merged.raisedXLM);
  merged.progressPercent = finalGoal > 0 ? Math.round((finalRaised / finalGoal) * 100) : 0;
  merged.completed = finalRaised >= finalGoal;

  return merged;
}

export interface MilestoneOverrides extends Partial<Omit<Milestone, "id" | "createdAt">> {
  id?: string;
  createdAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic Milestone fixture.
 */
export function milestone(overrides: MilestoneOverrides = {}): Milestone {
  const baseSeed = overrides.seed ?? (overrides.id ? hashString(overrides.id) : 500);
  const rng = createRNG(baseSeed);

  const now = seededDate(rng);

  const base: Milestone = {
    id: randomUUID(rng),
    projectId: randomUUID(rng),
    percentage: rng.pick([25, 50, 75, 100]),
    title: rng.pick(["Phase 1: Planning", "Phase 2: Implementation", "Phase 3: Completion"]),
    reachedAt: null,
    transactionHash: null,
    createdAt: now,
  };

  return { ...base, ...stripSeed(overrides as any) };
}

export interface UpdateOverrides extends Partial<Omit<ProjectUpdate, "id" | "createdAt">> {
  id?: string;
  createdAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic ProjectUpdate fixture.
 */
export function update(overrides: UpdateOverrides = {}): ProjectUpdate {
  const baseSeed = overrides.seed ?? (overrides.id ? hashString(overrides.id) : 600);
  const rng = createRNG(baseSeed);

  const now = seededDate(rng);

  const base: ProjectUpdate = {
    id: randomUUID(rng),
    projectId: randomUUID(rng),
    title: "Progress Report",
    body: "We've made great progress this quarter.",
    createdAt: now,
  };

  return { ...base, ...stripSeed(overrides as any) };
}

export interface QueueItemOverrides extends Partial<Omit<QueueItem, "id" | "createdAt">> {
  id?: string;
  createdAt?: string;
  /** Seed for deterministic generation. */
  seed?: number;
}

/**
 * Build a deterministic QueueItem fixture for offline / retry scenarios.
 */
export function queueItem(overrides: QueueItemOverrides = {}): QueueItem {
  const baseSeed = overrides.seed ?? (overrides.id ? hashString(overrides.id) : 700);
  const rng = createRNG(baseSeed);

  const now = seededDate(rng);

  const base: QueueItem = {
    id: randomUUID(rng),
    type: "donation",
    payload: {},
    status: "pending",
    createdAt: now,
    retryCount: 0,
    maxRetries: 3,
    nextRetryAt: null,
    idempotencyKey: randomUUID(rng),
  };

  return { ...base, ...stripSeed(overrides as any) };
}

/**
 * Build a deterministic API response wrapper.
 */
export function apiResponse<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/**
 * Build a deterministic paginated API response.
 */
export function paginatedResponse<T>(items: T[]): {
  success: true;
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
} {
  return {
    success: true,
    data: items,
    next_cursor: null,
    has_more: false,
  };
}

/**
 * Build a timeline of donations for a project.
 */
export function timeline(
  projectId: string,
  count: number = 5,
  overrides: { projectName?: string; projectCategory?: string; seed?: number; donations?: Donation[] } = {},
): TimelineEntry[] {
  const rng = createRNG(overrides.seed ?? (hashString(projectId) + count));
  let running = 0;
  const entries: TimelineEntry[] = [];

  // Use pre-supplied donations if provided, otherwise generate them
  const donations = overrides.donations ?? Array.from({ length: count }, () => {
    const amount = rng.float(1, 100);
    return donation({ projectId, amountXLM: formatXLM(amount), seed: rng.int(1, 100000) });
  });

  for (const d of donations) {
    running += parseFloat(d.amountXLM ?? d.amount);
    entries.push({
      donation: d,
      project: {
        id: projectId,
        name: overrides.projectName ?? "Test Project",
        category: overrides.projectCategory ?? "Reforestation",
      },
      matchedAmount: rng.pick([null, formatXLM(rng.float(0, parseFloat(d.amountXLM ?? d.amount)))]),
      runningTotal: formatXLM(running),
    });
  }

  return entries;
}

// ── Internal Helpers ──────────────────────────────────────────────────

/**
 * Simple string hash for deterministic seeding from arbitrary strings.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}
