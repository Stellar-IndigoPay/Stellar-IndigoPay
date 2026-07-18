/**
 * lib/api.ts — Backend HTTP client
 *
 * Typed helper functions for calling the IndigoPay backend from the Next.js app.
 * Each function maps closely to a backend route and returns the unwrapped `data`
 * payload from the API response.
 */
import axios from "axios";
import type {
  ClimateProject,
  Donation,
  DonorProfile,
  FreelancerProfile,
  ProjectUpdate,
  LeaderboardEntry,
  EscrowJob,
  ProjectCampaign,
} from "@/utils/types";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  headers: { "Content-Type": "application/json" },
  timeout: 10000,
  withCredentials: true,
});

// All API routes are served under the versioned `/api/v1` prefix (issue #204).
// Rewrite `/api/*` request paths to `/api/v1/*` from a single place so every
// helper below stays on the unversioned path string.
api.interceptors.request.use((config) => {
  if (
    config.url &&
    config.url.startsWith("/api/") &&
    !config.url.startsWith("/api/v1/")
  ) {
    config.url = config.url.replace(/^\/api\//, "/api/v1/");
  }
  return config;
});

let csrfToken: string | null = null;

async function refreshCsrfToken() {
  const { data } = await api.get<{ success: boolean; csrfToken: string }>(
    "/api/csrf-token",
  );
  csrfToken = data.csrfToken;
  return csrfToken;
}

api.interceptors.request.use(async (config) => {
  const method = config.method?.toUpperCase();
  const isMutating =
    method && ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (isMutating) {
    if (!csrfToken) {
      await refreshCsrfToken();
    }

    if (csrfToken) {
      config.headers.set("X-CSRF-Token", csrfToken);
    }
  }

  return config;
});

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    if (error.response?.status === 403 && !error.config.__csrfRetry) {
      error.config.__csrfRetry = true;
      csrfToken = null;
      await refreshCsrfToken();
      if (csrfToken) {
        error.config.headers = {
          ...error.config.headers,
          "X-CSRF-Token": csrfToken,
        };
        return api.request(error.config);
      }
    }

    // Admin JWT 401 interceptor — refresh once and retry before giving up.
    // Only fires for requests that already carry an Authorization header
    // (i.e. admin-authenticated calls), so public API calls are unaffected.
    if (
      error.response?.status === 401 &&
      !error.config.__adminRetry &&
      error.config.headers?.Authorization
    ) {
      error.config.__adminRetry = true;
      try {
        // Dynamic import to avoid circular dependency at module init time.
        const { refreshAdminToken, markSessionExpired } = await import("./adminAuth");
        const newToken = await refreshAdminToken();
        if (newToken) {
          error.config.headers.Authorization = `Bearer ${newToken}`;
          return api.request(error.config);
        }
        // Refresh failed — session is gone. Mark expired so the route guard
        // redirects with reason=expired on the next navigation.
        markSessionExpired();
      } catch {
        // Refresh threw — mark expired and let the original 401 propagate.
        try {
          const { markSessionExpired } = await import("./adminAuth");
          markSessionExpired();
        } catch {
          // Best-effort — the route guard will catch it on next navigation.
        }
      }
    }

    return Promise.reject(error);
  },
);

export async function csrfFetch(input: RequestInfo, init: RequestInit = {}) {
  const method = init.method?.toUpperCase() || "GET";
  const needsToken = ["POST", "PUT", "PATCH", "DELETE"].includes(method);

  if (needsToken) {
    if (!csrfToken) {
      await refreshCsrfToken();
    }

    init.headers = {
      ...(init.headers as Record<string, string>),
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken ?? "",
    };
    init.credentials = "include";
  }

  return fetch(input, init);
}

// ── Projects ──────────────────────────────────────────────────────────────────
/**
 * Fetch a list of climate projects from the backend.
 *
 * @param params - Optional server-side filters.
 * @returns A list of projects matching the query.
 * @throws If the request fails (network error, timeout, or non-2xx response).
 *
 * @example
 * const projects = await fetchProjects({ verified: true, limit: 12 });
 * console.log("projects:", projects.length);
 */
export interface ProjectListFilters {
  category?: string;
  status?: string;
  verified?: boolean;
  search?: string;
  location?: string;
  co2Min?: number;
  co2Max?: number;
  limit?: number;
}

export async function fetchProjects(
  params?: ProjectListFilters,
): Promise<ClimateProject[]> {
  const { data } = await api.get<{ success: boolean; data: ClimateProject[] }>(
    "/api/projects",
    { params },
  );
  return data.data;
}

export interface ProjectFacetValue {
  value: string;
  count: number;
}

export interface ProjectFacets {
  category: ProjectFacetValue[];
  location: ProjectFacetValue[];
  status: ProjectFacetValue[];
}

/**
 * Fetch facet counts (how many projects match each category/location/status
 * value) scoped to the given filters, for rendering counts like
 * "Reforestation (12)" next to filter options that aren't active yet.
 */
export async function fetchProjectFacets(
  params?: ProjectListFilters,
): Promise<ProjectFacets> {
  const { data } = await api.get<{
    success: boolean;
    data: ClimateProject[];
    facets?: ProjectFacets;
  }>("/api/projects", {
    params: { ...params, facets: true, limit: 1 },
  });
  return data.facets || { category: [], location: [], status: [] };
}

/**
 * Fetch a single project by its id.
 *
 * @param id - Project id.
 * @returns The project.
 * @throws If the request fails (including 404s for missing projects).
 */
export async function fetchProject(id: string, walletAddress?: string) {
  const params: Record<string, string> = {};
  if (walletAddress) params.walletAddress = walletAddress;
  const { data } = await api.get<{ success: boolean; data: ClimateProject }>(
    `/api/projects/${id}`,
    { params },
  );
  return data.data;
}

export interface AISummaryResponse {
  aiSummary: string;
  aiSummaryGeneratedAt: string;
  aiSummaryModel: string;
  aiSummarySourceHash: string;
}

/**
 * Trigger backend AI-summary generation for a project. Server-side this is
 * gated to the project owner (caller's `adminAddress` must equal the
 * project's wallet address), so this should only be called from the admin
 * "Refresh summary" path.
 */
export async function generateProjectSummary(
  projectId: string,
  adminAddress: string,
): Promise<AISummaryResponse> {
  const { data } = await api.post<{
    success: boolean;
    data: AISummaryResponse;
  }>(`/api/projects/${projectId}/generate-summary`, { adminAddress });
  return data.data;
}

export async function createProjectCampaign(
  projectId: string,
  payload: {
    title: string;
    goalXLM: string;
    deadline: string;
    description?: string;
  },
) {
  const { data } = await api.post<{ success: boolean; data: ProjectCampaign }>(
    `/api/projects/${projectId}/campaigns`,
    payload,
  );
  return data.data;
}

// ── Matching ──────────────────────────────────────────────────────────────────
export async function fetchProjectMatches(projectId: string) {
  const { data } = await api.get<{
    success: boolean;
    data: Array<{
      id: string;
      projectId: string;
      matcherAddress: string;
      capXLM: string;
      multiplier: number;
      matchedXLM: string;
      remainingXLM: string;
      expiresAt: string;
      createdAt: string;
    }>;
  }>(`/api/projects/${projectId}/matching`);
  return data.data;
}

// ── Donations ─────────────────────────────────────────────────────────────────
/**
 * Persist a completed donation in the backend after the on-chain transaction succeeds.
 *
 * @param payload - Donation details, including the on-chain transaction hash.
 * @returns The stored donation record.
 * @throws If the request fails or validation is rejected by the backend.
 *
 * @example
 * await recordDonation({
 *   projectId: "project_123",
 *   donorAddress: "G...YOUR_PUBLIC_KEY...",
 *   amountXLM: "10",
 *   currency: "XLM",
 *   message: "Keep it up!",
 *   transactionHash: "abc123deadbeef",
 * });
 */
export async function recordDonation(payload: {
  projectId: string;
  donorAddress: string;
  amountXLM?: string;
  amount?: string;
  currency?: string;
  message?: string;
  transactionHash: string;
  sourceAsset?: string;
  conversionPath?: Array<{ code: string; issuer: string }>;
  convertedAmountXLM?: string;
  idempotencyKey?: string;
}) {
  const headers: Record<string, string> = {};
  if (payload.idempotencyKey) {
    headers["Idempotency-Key"] = payload.idempotencyKey;
  }
  const { data } = await api.post<{ success: boolean; data: Donation }>(
    "/api/donations",
    payload,
    { headers },
  );
  return data.data;
}

/**
 * Fetch donations for a project using cursor pagination.
 *
 * @param projectId - Project id.
 * @param limit - Maximum number of donations to return (default: 20).
 * @param cursor - Optional cursor from a previous call.
 * @returns Donations page and a cursor for the next page (or `null` when done).
 * @throws If the request fails.
 */
export async function fetchProjectDonations(
  projectId: string,
  limit = 20,
  cursor?: string,
) {
  const params: { limit: number; cursor?: string } = { limit };
  if (cursor) params.cursor = cursor;
  const { data } = await api.get<{
    success: boolean;
    data: Donation[];
    nextCursor: string | null;
  }>(`/api/donations/project/${projectId}`, { params });
  return { donations: data.data, nextCursor: data.nextCursor };
}

/**
 * Fetch all donations made by a donor.
 *
 * @param publicKey - Donor Stellar public key.
 * @returns Donation history.
 * @throws If the request fails.
 */
export async function fetchDonorHistory(publicKey: string) {
  const { data } = await api.get<{ success: boolean; data: Donation[] }>(
    `/api/donations/donor/${publicKey}`,
  );
  return data.data;
}

// ── Profiles ──────────────────────────────────────────────────────────────────
/**
 * Fetch a donor profile by public key.
 *
 * @param publicKey - Donor Stellar public key.
 * @returns Donor profile.
 * @throws If the request fails.
 */
export async function fetchProfile(publicKey: string) {
  const { data } = await api.get<{ success: boolean; data: DonorProfile }>(
    `/api/profiles/${publicKey}`,
  );
  return data.data;
}

/**
 * Fetch a freelancer profile by public key.
 *
 * @param publicKey - Freelancer Stellar public key.
 * @returns Freelancer profile.
 * @throws If the request fails.
 */
export async function fetchFreelancerProfile(publicKey: string) {
  const { data } = await api.get<{ success: boolean; data: FreelancerProfile }>(
    `/api/profiles/${publicKey}`,
  );
  return data.data;
}

/**
 * Create or update a donor profile.
 *
 * @param payload - Profile fields to upsert.
 * @returns The upserted profile.
 * @throws If the request fails or validation is rejected by the backend.
 */
export async function upsertProfile(
  payload: Partial<DonorProfile> & { publicKey: string },
) {
  const { data } = await api.post<{ success: boolean; data: DonorProfile }>(
    "/api/profiles",
    payload,
  );
  return data.data;
}

// ── Leaderboard ───────────────────────────────────────────────────────────────
/**
 * Fetch top donors.
 *
 * @param limit - Maximum number of entries to return (default: 20).
 * @returns Leaderboard entries.
 * @throws If the request fails.
 */
export async function fetchLeaderboard(limit = 20, period?: string) {
  const params: Record<string, unknown> = { limit };
  if (period) params.period = period;
  const { data } = await api.get<{
    success: boolean;
    data: LeaderboardEntry[];
  }>("/api/leaderboard", { params });
  return data.data;
}

// ── Jobs (escrow) ───────────────────────────────────────────────────────────
/**
 * Fetch all escrow jobs.
 *
 * @returns List of jobs.
 * @throws If the request fails.
 */
export async function fetchJobs() {
  const { data } = await api.get<{ success: boolean; data: EscrowJob[] }>(
    "/api/jobs",
  );
  return data.data;
}

/**
 * Fetch a single escrow job by id.
 *
 * @param id - Job id.
 * @returns The job.
 * @throws If the request fails (including 404s for missing jobs).
 */
export async function fetchJob(id: string) {
  const { data } = await api.get<{ success: boolean; data: EscrowJob }>(
    `/api/jobs/${id}`,
  );
  return data.data;
}

/**
 * Mark job completed after on-chain release_escrow succeeds (stores release tx hash).
 *
 * @param jobId - Job id.
 * @param releaseTransactionHash - Hash of the on-chain release transaction.
 * @returns Updated job record.
 * @throws If the request fails or the backend rejects the update.
 */
export async function completeJobRelease(
  jobId: string,
  releaseTransactionHash: string,
) {
  const { data } = await api.patch<{ success: boolean; data: EscrowJob }>(
    `/api/jobs/${jobId}/release`,
    { releaseTransactionHash },
  );
  return data.data;
}

// ── Project Updates ─────────────────────────────────────────────
/**
 * Fetch updates for a project.
 *
 * @param projectId - Project id.
 * @returns List of updates.
 * @throws If the request fails.
 */
export async function fetchProjectUpdates(projectId: string) {
  const { data } = await api.get<{ success: boolean; data: ProjectUpdate[] }>(
    `/api/updates/${projectId}`,
  );
  return data.data;
}

export async function createProjectUpdate(payload: {
  projectId: string;
  title: string;
  body: string;
  adminKey?: string;
}) {
  const { data } = await api.post<{ success: boolean; data: ProjectUpdate }>(
    "/api/updates",
    payload,
  );
  return data.data;
}

// ── Subscriptions ────────────────────────────────────────────────
/**
 * Subscribe an email (and optionally a donor address) to a project's updates.
 *
 * @param payload - Subscription payload.
 * @returns Backend response including a success flag and message.
 * @throws If the request fails or validation is rejected by the backend.
 */
export async function subscribeToProject(payload: {
  projectId: string;
  email: string;
  donorAddress?: string;
}) {
  const { data } = await api.post<{ success: boolean; message: string }>(
    "/api/subscriptions",
    payload,
  );
  return data;
}

/**
 * Fetch the number of subscribers for a project.
 *
 * @param projectId - Project id.
 * @returns Subscriber count.
 * @throws If the request fails.
 */
export async function fetchSubscriberCount(projectId: string) {
  const { data } = await api.get<{ success: boolean; count: number }>(
    `/api/subscriptions/${projectId}/count`,
  );
  return data.count;
}

// ── Global Stats ─────────────────────────────────────────────────
export interface GlobalStats {
  totalXLMRaised: string;
  totalCO2OffsetKg: number;
  totalDonations: number;
  totalProjects: number;
  totalDonors: number;
}

function normalizeGlobalStats(stats: Partial<GlobalStats>): GlobalStats {
  return {
    totalXLMRaised: stats.totalXLMRaised || "0.0000000",
    totalCO2OffsetKg: stats.totalCO2OffsetKg || 0,
    totalDonations: stats.totalDonations || 0,
    totalProjects: stats.totalProjects || 0,
    totalDonors: stats.totalDonors || 0,
  };
}

/**
 * Fetch global platform statistics.
 *
 * @returns Global statistics object.
 * @throws If the request fails.
 */
export async function fetchGlobalStats(): Promise<GlobalStats> {
  const { data } = await api.get<
    GlobalStats | { success: boolean; data: GlobalStats }
  >("/api/stats/global");

  if ("data" in data && "success" in data) {
    return normalizeGlobalStats(data.data);
  }

  return normalizeGlobalStats(data);
}

// ── Cross-Chain Attestations ────────────────────────────────────────────
/**
 * Cross-chain donation attestation shape returned by the backend.
 */
export interface CrossChainAttestation {
  id: string;
  onChainId: number | null;
  sourceChain: string;
  sourceTxHash: string;
  donorAddress: string;
  projectId: string | null;
  amountUsd: string | null;
  amountXlm: string | null;
  status: "pending" | "verified" | "revoked";
  messageHash: number | null;
  createdAt: string;
  verifiedAt: string | null;
}

/**
 * Attestation roll-up stats returned by GET /api/attestations.
 */
export interface AttestationStats {
  total: number;
  pending: number;
  verified: number;
  revoked: number;
  byChain: Array<{ sourceChain: string; count: number }>;
}

/**
 * Look up an attestation by its source-chain (chain, tx hash) pair.
 */
export async function fetchAttestationBySource(
  sourceChain: string,
  sourceTxHash: string,
): Promise<CrossChainAttestation | null> {
  try {
    const { data } = await api.get<{
      success: boolean;
      data: CrossChainAttestation;
    }>("/api/attestations/by-source", {
      params: { source_chain: sourceChain, source_tx_hash: sourceTxHash },
    });
    return data.data;
  } catch (err: unknown) {
    if (axios.isAxiosError(err) && err.response?.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch platform-wide attestation roll-up stats.
 */
export async function fetchAttestationStats(): Promise<AttestationStats> {
  const { data } = await api.get<{
    success: boolean;
    data: AttestationStats;
  }>("/api/attestations");
  return data.data;
}

// ── Tag Suggestions ────────────────────────────────────────────────
/**
 * Fetch tag suggestions for autocomplete.
 */
export async function fetchTagSuggestions(query: string): Promise<string[]> {
  const { data } = await api.get<{ success: boolean; data: string[] }>(
    "/api/tags/suggestions",
    { params: { q: query } },
  );
  return data.data;
}

/**
 * Notify an admin (placeholder function for future use).
 */
export async function notifyAdmin(
  payload: AdminNotificationPayload,
): Promise<void> {
  await api.post("/api/admin/notify", payload);
}

// ── Follow / Unfollow ──────────────────────────────────────────────
/**
 * Follow a project.
 * @returns Updated follow state and count.
 */
export async function followProject(projectId: string, walletAddress: string) {
  const { data } = await api.post<{
    success: boolean;
    data: { isFollowing: boolean; followCount: number };
  }>(`/api/projects/${projectId}/follow`, { walletAddress });
  return data.data;
}

/**
 * Unfollow a project.
 * @returns Updated follow state and count.
 */
export async function unfollowProject(
  projectId: string,
  walletAddress: string,
) {
  const { data } = await api.delete<{
    success: boolean;
    data: { isFollowing: boolean; followCount: number };
  }>(`/api/projects/${projectId}/follow`, { data: { walletAddress } });
  return data.data;
}

// ── Admin: Project Approval ──────────────────────────────────────
export async function updateProjectStatus(
  projectId: string,
  status: "active" | "rejected" | "paused",
  reason?: string,
) {
  const { data } = await api.patch<{ success: boolean; data: ClimateProject }>(
    `/api/projects/${projectId}/status`,
    { status, reason },
  );
  return data.data;
}

export async function registerProjectOnChain(payload: {
  projectId: string;
  name: string;
  wallet: string;
  co2PerXLM: number;
  adminAddress: string;
}) {
  const { data } = await api.post<{ success: boolean; xdr: string }>(
    "/api/projects/admin/register",
    payload,
  );
  return data;
}

export async function confirmProjectRegistration(payload: {
  projectId: string;
  transactionHash: string;
}) {
  const { data } = await api.post<{ success: boolean; data: ClimateProject }>(
    "/api/projects/admin/confirm",
    payload,
  );
  return data;
}

// ── Notifications ─────────────────────────────────────────────────
export interface UnreadNotificationCountParams {
  token: string;
  lastSeen?: string;
}

export async function fetchUnreadNotificationCount({
  token,
  lastSeen,
}: UnreadNotificationCountParams): Promise<number> {
  const params: Record<string, string> = { token };
  if (lastSeen) params.lastSeen = lastSeen;

  const { data } = await api.get<{ unreadCount: number }>(
    "/api/notifications/unread-count",
    { params },
  );
  return data.unreadCount;
}

// ── Update Likes ─────────────────────────────────────────────────
export async function toggleUpdateLike(updateId: string, donorAddress: string) {
  const { data } = await api.post<{
    success: boolean;
    data: { liked: boolean; likeCount: number };
  }>(`/api/updates/${updateId}/like`, { donorAddress });
  return data.data;
}

export async function fetchUpdateLikes(
  updateId: string,
  donorAddress?: string,
) {
  const params: Record<string, string> = {};
  if (donorAddress) params.donorAddress = donorAddress;
  const { data } = await api.get<{
    success: boolean;
    data: { liked: boolean; likeCount: number };
  }>(`/api/updates/${updateId}/likes`, { params });
  return data.data;
}

// ── Project Analytics ─────────────────────────────────────────────

export interface ProjectAnalytics {
  projectId: string;
  projectName: string;
  donorOverview: {
    totalDonors: number;
    newDonors30d: number;
    avgDonationXLM: string;
    medianDonationXLM: string;
    totalRaisedXLM: string;
    totalDonations: number;
  };
  topDonors: Array<{
    donorAddress: string;
    totalContributed: string;
    donationCount: number;
    lastDonationAt: string | null;
  }>;
  donationTimeline: Array<{
    date: string;
    total: string;
    count: number;
  }>;
  donationDistribution: Array<{
    bucket: string;
    count: number;
    total: string;
  }>;
  donorRetention: {
    totalDonors: number;
    returningDonors: number;
    oneTimeDonors: number;
    retentionPct: number;
  };
  milestones: Array<{
    id: string;
    title: string;
    percentage: number;
    reached: boolean;
    reachedAt: string | null;
    transactionHash: string | null;
    currentProgress: number;
  }>;
  campaigns: Array<{
    id: string;
    title: string;
    goalXLM: string;
    raisedXLM: string;
    deadline: string;
    progressPercent: number;
    status: string;
  }>;
  ratingSummary: {
    averageRating: number;
    totalRatings: number;
    distribution: Record<number, number>;
  };
}

/**
 * Fetch project analytics. Only the project owner (wallet) can access.
 */
export async function fetchProjectAnalytics(
  projectId: string,
  wallet: string,
): Promise<ProjectAnalytics> {
  const { data } = await api.get<{ success: boolean; data: ProjectAnalytics }>(
    `/api/projects/${projectId}/analytics`,
    { params: { wallet } },
  );
  return data.data;
}

// ── Featured Project ─────────────────────────────────────────────
/**
 * Fetch the featured project, if one is configured by the backend.
 *
 * @returns The featured project, or `null` if none exists or the request fails.
 * @throws Never; backend errors are caught and converted to `null`.
 */
export async function fetchFeaturedProject(): Promise<ClimateProject | null> {
  try {
    const { data } = await api.get<{ success: boolean; data: ClimateProject }>(
      "/api/projects/featured",
    );
    return data.data;
  } catch {
    return null;
  }
}

// ── Category Stats ───────────────────────────────────────────────
export interface CategoryStats {
  category: string;
  count: number;
}

export async function fetchCategoryStats(): Promise<CategoryStats[]> {
  const { data } = await api.get<{ success: boolean; data: CategoryStats[] }>(
    "/api/stats/categories",
  );
  return data.data;
}

// ── Impact Aggregation ───────────────────────────────────────────────────────
export interface ImpactProjectStats {
  totalDonationsXLM: string;
  donorCount: number;
  co2OffsetKg: number;
  treesEquivalent: number;
  uniqueCountries: number;
}

export interface ImpactCategoryBreakdownItem {
  category: string;
  totalDonationsXLM: string;
  donorCount: number;
  co2OffsetKg: number;
}

export interface ImpactGlobalStats extends ImpactProjectStats {
  breakdownByCategory: ImpactCategoryBreakdownItem[];
}

export interface ImpactDonorStats {
  totalDonatedXLM: string;
  co2OffsetKg: number;
  projectsSupported: number;
  topCategory: string | null;
}

export async function fetchImpactProject(
  projectId: string,
): Promise<ImpactProjectStats> {
  const { data } = await api.get<{
    success: boolean;
    data: ImpactProjectStats;
  }>(`/api/impact/project/${projectId}`);
  return data.data;
}

export async function fetchImpactGlobal(): Promise<ImpactGlobalStats> {
  const { data } = await api.get<{ success: boolean; data: ImpactGlobalStats }>(
    "/api/impact/global",
  );
  return data.data;
}

export async function fetchImpactDonor(
  publicKey: string,
): Promise<ImpactDonorStats> {
  const { data } = await api.get<{ success: boolean; data: ImpactDonorStats }>(
    `/api/impact/donor/${publicKey}`,
  );
  return data.data;
}

export interface SubmitProjectPayload {
  name: string;
  category: string;
  description: string;
  location: string;
  goalXLM: string;
  walletAddress: string;
  organization: {
    name: string;
    website: string;
    country: string;
    contactEmail: string;
  };
  co2Methodology: {
    name: string;
    verificationBody: string;
    annualTonnesCO2: string;
    documentUrl: string;
  };
}

export interface SubmitProjectResponse {
  id: string;
  reviewTimeline: string;
}

export interface AdminNotificationPayload {
  projectName: string;
  contactEmail: string;
  impactMetrics: string[];
}

export async function submitProject(
  payload: SubmitProjectPayload,
): Promise<SubmitProjectResponse> {
  const { data } = await api.post<{
    success: boolean;
    data: SubmitProjectResponse;
  }>("/api/projects", payload);
  return data.data;
}

// ── Verification Requests (/apply) ───────────────────────────────────────────
export interface VerificationDocument {
  name: string;
  url: string;
  size?: number;
  contentType?: string;
  backend?: "local" | "s3" | "ipfs";
}

export interface VerificationRequestPayload {
  organizationName: string;
  organizationWebsite?: string;
  organizationCountry?: string;
  contactEmail: string;
  walletAddress: string;
  projectName: string;
  projectCategory: string;
  projectLocation: string;
  projectDescription?: string;
  co2PerXLM: string;
  expectedAnnualTonnesCO2?: string;
  supportingDocuments?: VerificationDocument[];
  notes?: string;
}

export interface VerificationRequestResponse {
  id: string;
  organizationName: string;
  organizationWebsite: string | null;
  organizationCountry: string | null;
  contactEmail: string;
  walletAddress: string;
  projectName: string;
  projectCategory: string;
  projectLocation: string;
  projectDescription: string | null;
  co2PerXLM: string;
  expectedAnnualTonnesCO2: string | null;
  supportingDocuments: VerificationDocument[];
  storageBackend: "local" | "s3" | "ipfs";
  notes: string | null;
  status: "pending" | "in_review" | "approved" | "rejected";
  reviewerNotes: string | null;
  reviewedBy: string | null;
  submittedAt: string;
  reviewedAt: string | null;
  reviewTimeline: string;
}

export async function submitVerificationRequest(
  payload: VerificationRequestPayload,
): Promise<VerificationRequestResponse> {
  const { data } = await api.post<{
    success: boolean;
    data: VerificationRequestResponse;
  }>("/api/verification-requests", payload);
  return data.data;
}

export async function fetchMyVerificationRequests(
  walletAddress: string,
): Promise<VerificationRequestResponse[]> {
  const { data } = await api.get<{
    success: boolean;
    data: VerificationRequestResponse[];
  }>("/api/verification-requests/me", { params: { wallet: walletAddress } });
  return data.data;
}

export async function fetchVerificationRequest(
  id: string,
  walletAddress?: string,
): Promise<VerificationRequestResponse> {
  const params: Record<string, string> = {};
  if (walletAddress) params.wallet = walletAddress;
  const { data } = await api.get<{
    success: boolean;
    data: VerificationRequestResponse;
  }>(`/api/verification-requests/${id}`, { params });
  return data.data;
}

export interface UploadedDocument {
  key: string;
  url: string;
  size: number;
  contentType: string;
  backend: "local" | "s3" | "ipfs";
  originalName: string;
}

/**
 * Uploads a file to /api/uploads. The backend stores it according to
 * STORAGE_BACKEND (local disk by default) and returns a URL that the
 * verification form stashes into `supportingDocuments[]` on submit.
 */
export async function uploadSupportingDocument(
  file: File,
): Promise<UploadedDocument> {
  // CSRF + multipart: axios automatically sets the right Content-Type when
  // given a FormData body; we still need the X-CSRF-Token header, which the
  // request interceptor already adds on POSTs.
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<{ success: boolean; data: UploadedDocument }>(
    "/api/uploads",
    form,
  );
  return data.data;
}

// ── Admin: Queue Monitoring & Actions ──────────────────────────────
export interface QueueMetric {
  queue: string;
  active: number;
  waiting: number;
  failed: number;
  completed: number;
  depth: number;
  failure_rate: number;
  latency: number;
  paused: boolean;
}

export async function fetchQueues(adminKey: string): Promise<QueueMetric[]> {
  const { data } = await api.get<{ success: boolean; data: QueueMetric[] }>(
    "/api/admin/queues",
    {
      headers: { "X-Admin-Key": adminKey },
    },
  );
  return data.data;
}

export async function pauseQueue(name: string, adminKey: string): Promise<boolean> {
  const { data } = await api.post<{ success: boolean }>(
    `/api/admin/queues/${name}/pause`,
    {},
    {
      headers: { "X-Admin-Key": adminKey },
    },
  );
  return data.success;
}

export async function resumeQueue(name: string, adminKey: string): Promise<boolean> {
  const { data } = await api.post<{ success: boolean }>(
    `/api/admin/queues/${name}/resume`,
    {},
    {
      headers: { "X-Admin-Key": adminKey },
    },
  );
  return data.success;
}

export async function purgeQueue(name: string, adminKey: string): Promise<boolean> {
  const { data } = await api.post<{ success: boolean }>(
    `/api/admin/queues/${name}/purge`,
    {},
    {
      headers: { "X-Admin-Key": adminKey },
    },
  );
  return data.success;
}

// ── Admin: Webhook Dead-Letter Queue Management ──────────────────────────────
export interface WebhookDelivery {
  id: string;
  projectId: string;
  projectName: string | null;
  eventId: string;
  eventType: string;
  status: "pending" | "delivered" | "failed" | "dlq";
  attempts: number;
  lastAttemptAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function fetchDeadLetterWebhooks(
  adminKey: string,
  params?: { projectId?: string; limit?: number; page?: number },
): Promise<{ data: WebhookDelivery[]; total: number; page: number; pageSize: number }> {
  const { data } = await api.get<{
    success: boolean;
    data: WebhookDelivery[];
    total: number;
    page: number;
    pageSize: number;
  }>("/api/admin/webhooks/dead-letter", {
    params,
    headers: { "X-Admin-Key": adminKey },
  });
  return data;
}

export async function replayWebhookDelivery(
  deliveryId: string,
  adminKey: string,
): Promise<WebhookDelivery> {
  const { data } = await api.post<{ success: boolean; data: WebhookDelivery }>(
    `/api/admin/webhooks/dead-letter/${deliveryId}/replay`,
    {},
    { headers: { "X-Admin-Key": adminKey } },
  );
  return data.data;
}

export async function replayAllWebhookDeliveries(
  projectId: string,
  adminKey: string,
): Promise<number> {
  const { data } = await api.post<{ success: boolean; count: number }>(
    "/api/admin/webhooks/dead-letter/replay-all",
    { projectId },
    { headers: { "X-Admin-Key": adminKey } },
  );
  return data.count;
}

export async function fetchWebhookDeliveries(
  adminKey: string,
  params?: { projectId?: string; status?: string; limit?: number },
): Promise<WebhookDelivery[]> {
  const { data } = await api.get<{ success: boolean; data: WebhookDelivery[] }>(
    "/api/admin/webhooks/deliveries",
    {
      params,
      headers: { "X-Admin-Key": adminKey },
    },
  );
  return data.data;
}

// ── Admin Analytics ────────────────────────────────────────────────

export interface AdminDonationTrend {
  day: string;
  donationCount: number;
  totalXLM: string;
  uniqueDonors: number;
  avgDonationXLM: string;
}

export interface AdminProjectPerformance {
  id: string;
  name: string;
  category: string;
  location: string;
  raisedXLM: string;
  donorCount: number;
  goalXLM: string;
  co2OffsetKg: number;
  status: string;
  verified: boolean;
  progressPct: number;
  totalDonations: number;
  lastDonationAt: string | null;
  createdAt: string | null;
}

export interface AdminGeographicImpact {
  country: string;
  projectCount: number;
  totalXLM: string;
  donorCount: number;
  totalCO2Kg: number;
}

export interface AdminDonorRetention {
  cohortMonth: string;
  cohortSize: number;
  activityMonth: string;
  activeDonors: number;
  retentionPct: number;
}

export interface AdminCategoryBreakdown {
  category: string;
  donationCount: number;
  totalXLM: string;
  donorCount: number;
}

export interface AdminGrowthData {
  summary: {
    totalProjects: number;
    totalDonations: number;
    totalDonors: number;
    totalXLM: string;
    activeDonors30d: number;
    totalXLM30d: string;
  };
  monthlyGrowth: Array<{
    month: string;
    donations: number;
    totalXLM: string;
    donors: number;
  }>;
}

async function fetchAdminAnalytics<T>(
  endpoint: string,
  adminKey: string,
  params?: Record<string, string>,
): Promise<T> {
  const { data } = await api.get<{ success: boolean; data: T }>(
    `/api/admin/analytics/${endpoint}`,
    {
      params,
      headers: { "X-Admin-Key": adminKey },
    },
  );
  return data.data;
}

export async function fetchAdminDonationTrends(
  adminKey: string,
  range?: { from?: string; to?: string },
): Promise<AdminDonationTrend[]> {
  return fetchAdminAnalytics<AdminDonationTrend[]>("trends", adminKey, range as Record<string, string>);
}

export async function fetchAdminProjectPerformance(
  adminKey: string,
): Promise<AdminProjectPerformance[]> {
  return fetchAdminAnalytics<AdminProjectPerformance[]>("projects", adminKey);
}

export async function fetchAdminGeographicImpact(
  adminKey: string,
): Promise<AdminGeographicImpact[]> {
  return fetchAdminAnalytics<AdminGeographicImpact[]>("geographic", adminKey);
}

export async function fetchAdminDonorRetention(
  adminKey: string,
): Promise<AdminDonorRetention[]> {
  return fetchAdminAnalytics<AdminDonorRetention[]>("retention", adminKey);
}

export async function fetchAdminCategoryBreakdown(
  adminKey: string,
  range?: { from?: string; to?: string },
): Promise<AdminCategoryBreakdown[]> {
  return fetchAdminAnalytics<AdminCategoryBreakdown[]>("categories", adminKey, range as Record<string, string>);
}

export async function fetchAdminPlatformGrowth(
  adminKey: string,
): Promise<AdminGrowthData> {
  return fetchAdminAnalytics<AdminGrowthData>("growth", adminKey);
}

export async function exportAdminAnalytics(
  adminKey: string,
  view: string,
  format: "csv" | "json",
  range?: { from?: string; to?: string },
): Promise<void> {
  const params = new URLSearchParams({ view, type: format });
  if (range?.from) params.set("from", range.from);
  if (range?.to) params.set("to", range.to);

  const resp = await fetch(
    `${api.defaults.baseURL}/api/v1/admin/analytics/export?${params.toString()}`,
    { headers: { "X-Admin-Key": adminKey } },
  );
  if (!resp.ok) throw new Error(`Export failed: ${resp.status}`);

  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${view}.${format}`;
  a.click();
  URL.revokeObjectURL(url);
}
