import axios from "axios";
import type { ClimateProject } from "@/utils/types";

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000",
  withCredentials: true,
  headers: {
    "Content-Type": "application/json",
  },
});

// ── CSRF ──────────────────────────────────────────────────────────────────

/**
 * Fetch a CSRF token from the backend and return it.
 * The backend sets an httpOnly cookie; we read the plain-text response.
 */
export async function csrfFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

  // 1. Fetch CSRF token
  const csrfRes = await fetch(`${baseUrl}/api/csrf-token`, {
    credentials: "include",
  });
  const { csrfToken } = await csrfRes.json();

  // 2. Perform the actual request with the CSRF token
  return fetch(url, {
    ...options,
    credentials: "include",
    headers: {
      ...options.headers,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken,
    },
  });
}

// ── Projects ──────────────────────────────────────────────────────────────

/**
 * Fetch a single project by its ID.
 */
export async function fetchProject(id: string): Promise<ClimateProject> {
  const { data } = await api.get<{ success: boolean; data: ClimateProject }>(
    `/api/projects/${id}`,
  );
  return data.data;
}

export interface ProjectListParams {
  page?: number;
  limit?: number;
  category?: string;
  sort?: string;
  search?: string;
  status?: string;
  verified?: boolean;
}

export interface ProjectListResponse {
  projects: ClimateProject[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/**
 * Fetch a paginated list of projects.
 */
export async function fetchProjects(
  params: ProjectListParams = {},
): Promise<ProjectListResponse> {
  const { data } = await api.get<{
    success: boolean;
    data: ProjectListResponse;
  }>("/api/projects", { params });
  return data.data;
}

/**
 * Fetch donations for a project.
 */
export async function fetchProjectDonations(
  projectId: string,
  limit = 50,
  cursor?: string,
) {
  const params: Record<string, string | number> = { limit };
  if (cursor) params.cursor = cursor;
  const { data } = await api.get<{
    success: boolean;
    data: { donations: any[]; nextCursor: string | null };
  }>(`/api/projects/${projectId}/donations`, { params });
  return data.data;
}

/**
 * Fetch matching projects for a given project.
 */
export async function fetchProjectMatches(projectId: string) {
  const { data } = await api.get<{ success: boolean; data: any[] }>(
    `/api/projects/${projectId}/matches`,
  );
  return data.data;
}

// ── Project Updates ───────────────────────────────────────────────────────

export interface CreateUpdatePayload {
  projectId: string;
  title: string;
  body: string;
}

/**
 * Create a new project update.
 */
export async function createProjectUpdate(payload: CreateUpdatePayload) {
  const { data } = await api.post<{ success: boolean; data: any }>(
    `/api/projects/${payload.projectId}/updates`,
    payload,
  );
  return data.data;
}

/**
 * Fetch updates for a project.
 */
export async function fetchProjectUpdates(projectId: string) {
  const { data } = await api.get<{ success: boolean; data: any[] }>(
    `/api/projects/${projectId}/updates`,
  );
  return data.data;
}

// ── Subscriptions ─────────────────────────────────────────────────────────

/**
 * Subscribe an email (and optionally a donor address) to a project's updates.
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
 */
export async function fetchSubscriberCount(projectId: string) {
  const { data } = await api.get<{ success: boolean; count: number }>(
    `/api/subscriptions/${projectId}/count`,
  );
  return data.count;
}

// ── Global Stats ──────────────────────────────────────────────────────────

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

// ── Cross-Chain Attestations ──────────────────────────────────────────────

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

// ── Tag Suggestions ───────────────────────────────────────────────────────

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

// ── Follow / Unfollow ─────────────────────────────────────────────────────

/**
 * Follow a project.
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

// ── Admin: Project Approval ───────────────────────────────────────────────

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

// ── Notifications ─────────────────────────────────────────────────────────

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

// ── Update Likes ──────────────────────────────────────────────────────────

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

// ── Project Analytics ─────────────────────────────────────────────────────

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

// ── Featured Project ──────────────────────────────────────────────────────

/**
 * Fetch the featured project, if one is configured by the backend.
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

// ── Category Stats ────────────────────────────────────────────────────────

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

// ── Impact Aggregation ────────────────────────────────────────────────────

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

// ── Verification Requests (/apply) ────────────────────────────────────────

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
 * Uploads a file to /api/uploads.
 */
export async function uploadSupportingDocument(
  file: File,
): Promise<UploadedDocument> {
  const form = new FormData();
  form.append("file", file);
  const { data } = await api.post<{ success: boolean; data: UploadedDocument }>(
    "/api/uploads",
    form,
  );
  return data.data;
}

// ── Admin: Queue Monitoring & Actions ─────────────────────────────────────

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

// ── Admin: Webhook Dead-Letter Queue Management ───────────────────────────

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

// ── Admin: Webhook mTLS Configuration ─────────────────────────────────────

/**
 * mTLS configuration shape returned by the backend.
 */
export interface WebhookMTLSConfig {
  enabled: boolean;
  has_ca: boolean;
  has_client_cert: boolean;
  has_client_key: boolean;
  cert_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Fetch the current mTLS configuration for a project.
 */
export async function fetchWebhookMTLS(
  projectId: string,
  adminKey: string,
): Promise<WebhookMTLSConfig | null> {
  try {
    const { data } = await api.get<{
      success: boolean;
      data: WebhookMTLSConfig;
    }>(`/api/admin/webhooks/${projectId}/mtls`, {
      headers: { "X-Admin-Key": adminKey },
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
 * Upload and enable mTLS configuration for a project.
 */
export async function uploadWebhookMTLS(
  projectId: string,
  adminKey: string,
  payload: { caCert: string; clientCert: string; clientKey: string },
): Promise<{ cert_expires_at: string }> {
  const { data } = await api.post<{
    success: boolean;
    data: { cert_expires_at: string };
  }>(
    `/api/admin/webhooks/${projectId}/mtls`,
    {
      ca_cert: payload.caCert,
      client_cert: payload.clientCert,
      client_key: payload.clientKey,
    },
    { headers: { "X-Admin-Key": adminKey } },
  );
  return data.data;
}

/**
 * Disable mTLS without dropping the stored certificate material.
 */
export async function disableWebhookMTLS(
  projectId: string,
  adminKey: string,
): Promise<void> {
  await api.post(
    `/api/admin/webhooks/${projectId}/mtls/disable`,
    {},
    { headers: { "X-Admin-Key": adminKey } },
  );
}

/**
 * Test the mTLS connection against the project's webhook URL.
 */
export async function testWebhookMTLS(
  projectId: string,
  adminKey: string,
): Promise<{ success: boolean; statusCode?: number; error?: string }> {
  const { data } = await api.post<{
    success: boolean;
    data: { success: boolean; statusCode?: number; error?: string };
  }>(
    `/api/admin/webhooks/${projectId}/mtls/test`,
    {},
    { headers: { "X-Admin-Key": adminKey } },
  );
  return data.data;
}

// ── Admin Analytics ───────────────────────────────────────────────────────

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