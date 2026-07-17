/**
 * lib/adminAuth.ts — Admin session handling
 *
 * Admin auth is wallet-independent — admins log in with a username and
 * password and the backend opens a session: a short-lived access token in the
 * response body, and a rotating refresh token in an httpOnly cookie the
 * browser sends back on its own.
 *
 * The access token is held in memory and never persisted, so an XSS payload
 * has nothing to read out of storage and the refresh cookie stays beyond the
 * reach of page scripts. The cost is that a reload starts with no token, which
 * `ensureAdminSession` covers by refreshing once before deciding the admin is
 * logged out.
 */

let accessToken: string | null = null;

// One refresh in flight at a time. Concurrent refreshes would each rotate the
// cookie, and the losers would be replaying a token the winner already spent —
// which the backend reads as theft and answers by killing every session.
let inFlightRefresh: Promise<string | null> | null = null;

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Return the base URL for backend API calls.
 * Falls back to http://localhost:4000 in dev / test environments.
 */
function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
}

function authorizedFetch(
  url: string,
  options: RequestInit,
  token: string | null,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return fetch(url, { ...options, headers, credentials: "include" });
}

/**
 * Pull the most specific text out of the backend's error envelope,
 * `{ error: { code, message, reason } }` (see backend/src/errors.js). `message`
 * is the canonical text for the code — every 401 says "Authentication required"
 * — while `reason` carries what the call site actually rejected.
 */
function errorMessage(body: unknown): string {
  const error = (body as { error?: { message?: string; reason?: string } })
    ?.error;
  return (
    error?.reason || error?.message || "Login failed. Please try again."
  );
}

function redirectToLogin(): void {
  if (typeof window !== "undefined") {
    window.location.href = "/admin/login";
  }
}

async function requestRefreshedToken(): Promise<string | null> {
  try {
    const res = await fetch(`${apiBase()}/api/v1/admin/refresh`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      accessToken = null;
      return null;
    }

    const body = await res.json();
    accessToken = body.data?.token ?? null;
    return accessToken;
  } catch {
    accessToken = null;
    return null;
  }
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Send credentials to POST /api/admin/login and open a session.
 *
 * @param username - Admin username.
 * @param password - Admin password.
 * @returns The access token and its lifetime in seconds.
 * @throws If the server responds with a non-2xx status.
 */
export async function adminLogin(
  username: string,
  password: string,
): Promise<{ token: string; expiresIn: number }> {
  const res = await fetch(`${apiBase()}/api/v1/admin/login`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const body = await res.json();

  if (!res.ok) {
    throw new Error(errorMessage(body));
  }

  const { token, expiresIn } = body.data;
  accessToken = token;

  return { token, expiresIn };
}

/**
 * Retrieve the in-memory admin access token.
 *
 * @returns The token string, or `null` when no session is loaded.
 */
export function getAdminToken(): string | null {
  return accessToken;
}

/**
 * Returns `true` when an access token is loaded in this tab. A `false` here
 * only means the token is absent — the refresh cookie may still be valid, so
 * prefer `ensureAdminSession` for auth guards.
 */
export function isAdminAuthenticated(): boolean {
  return accessToken !== null && accessToken.length > 0;
}

/**
 * Exchange the refresh cookie for a new access token.
 *
 * Callers share a single in-flight request, so parallel 401s produce one
 * rotation rather than a burst the backend would treat as token reuse.
 *
 * @returns The new access token, or `null` if the session is gone.
 */
export async function refreshAdminToken(): Promise<string | null> {
  if (!inFlightRefresh) {
    inFlightRefresh = requestRefreshedToken().finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

/**
 * Resolve whether this tab has a usable admin session, refreshing once from
 * the cookie if no token is loaded yet. Use this for page auth guards.
 */
export async function ensureAdminSession(): Promise<boolean> {
  if (isAdminAuthenticated()) return true;
  return (await refreshAdminToken()) !== null;
}

/**
 * End the admin session: revoke it server-side and drop the local token.
 */
export async function adminLogout(): Promise<void> {
  try {
    await fetch(`${apiBase()}/api/v1/admin/logout`, {
      method: "POST",
      credentials: "include",
      headers: accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : undefined,
    });
  } catch {
    // The session is being discarded either way; a failed call only leaves the
    // server-side rows to expire on their own.
  }
  accessToken = null;
}

/**
 * Thin wrapper around `fetch` that attaches the admin access token and keeps
 * the session alive across access-token expiry.
 *
 * On a 401 it refreshes once and retries; if that fails it clears the session
 * and redirects to `/admin/login`.
 *
 * @param url - Request URL (absolute, or relative to the API base).
 * @param options - Standard fetch options.
 * @returns The `fetch` Response.
 */
export async function adminFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const fullUrl = url.startsWith("http") ? url : `${apiBase()}${url}`;

  const res = await authorizedFetch(fullUrl, options, accessToken);
  if (res.status !== 401) return res;

  const newToken = await refreshAdminToken();
  if (newToken) {
    const retryRes = await authorizedFetch(fullUrl, options, newToken);
    if (retryRes.ok) return retryRes;

    accessToken = null;
    redirectToLogin();
    return retryRes;
  }

  redirectToLogin();
  return res;
}
