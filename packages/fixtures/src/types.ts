/**
 * Shared fixture types derived from the Stellar-IndigoPay OpenAPI spec.
 *
 * These types mirror the canonical API shapes so fixtures cannot drift
 * from the real API contract.
 */

// ── Domain Objects ─────────────────────────────────────────────────────

export interface Project {
  id: string;
  name: string;
  description: string;
  category: string;
  location: string;
  walletAddress: string;
  goalXLM: string;
  raisedXLM: string;
  donorCount: number;
  co2OffsetKg: number;
  status: "active" | "completed" | "paused" | "rejected";
  rejectionReason: string | null;
  verified: boolean;
  onChainVerified: boolean;
  tags: string[];
  aiSummary: string | null;
  aiSummaryGeneratedAt: string | null;
  aiSummaryModel: string | null;
  aiSummarySourceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Donation {
  id: string;
  projectId: string;
  donorAddress: string | null;
  amount: string;
  amountXLM: string | null;
  currency: string;
  message: string | null;
  transactionHash: string;
  createdAt: string;
  anonymous: boolean;
  receiptGeneratedAt: string | null;
}

export interface DonationMatch {
  id: string;
  projectId: string;
  matcherAddress: string;
  capXLM: string;
  multiplier: number;
  matchedXLM: string;
  remainingXLM: string;
  expiresAt: string;
  createdAt: string;
}

export interface Profile {
  publicKey: string;
  displayName: string | null;
  bio: string | null;
  totalDonatedXLM: string;
  projectsSupported: number;
  badges: Array<{ tier: string; earnedAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface Campaign {
  id: string;
  projectId: string;
  title: string;
  description: string;
  goalXLM: string;
  raisedXLM: string;
  deadline: string;
  progressPercent: number;
  completed: boolean;
  active: boolean;
  createdAt: string;
}

export interface Milestone {
  id: string;
  projectId: string;
  percentage: number;
  title: string;
  reachedAt: string | null;
  transactionHash: string | null;
  createdAt: string;
}

export interface ProjectUpdate {
  id: string;
  projectId: string;
  title: string;
  body: string;
  createdAt: string;
}

// ── Queue / Offline Items ─────────────────────────────────────────────

export interface QueueItem {
  id: string;
  type: "donation" | "profile_update" | "follow";
  payload: Record<string, unknown>;
  status: "pending" | "sent" | "failed";
  createdAt: string;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: string | null;
  idempotencyKey: string | null;
}

// ── Timeline (donation history) ───────────────────────────────────────

export interface TimelineEntry {
  donation: Donation;
  project: Pick<Project, "id" | "name" | "category">;
  matchedAmount: string | null;
  runningTotal: string;
}

// ── API Response Wrappers ─────────────────────────────────────────────

export interface ApiResponseSuccess<T> {
  success: true;
  data: T;
}

export interface ApiResponseError {
  error: string;
}

export interface PaginatedResponse<T> {
  success: true;
  data: T[];
  next_cursor: string | null;
  has_more: boolean;
}

// ── Fixture Options ───────────────────────────────────────────────────

export interface FixtureOptions {
  /** Seed for deterministic generation. Same seed → identical objects. */
  seed?: number;
}
