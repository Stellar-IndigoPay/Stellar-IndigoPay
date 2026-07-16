/**
 * lib/adminAuth.ts — Admin JWT authentication
 *
 * Provides a lightweight, fetch-based auth layer for the admin dashboard
 * area. Admin auth is wallet-independent — admins log in with a username
 * and password and receive a JWT from POST /api/admin/login.
 *
 * The adminFetch wrapper injects the Bearer token on every request and
 * handles 401 responses by clearing the token and redirecting to the
 * login page.
 */

const ADMIN_TOKEN_KEY = "indigopay:adminToken";
const ADMIN_REFRESH_KEY = "indigopay:adminRefreshToken";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Return the base URL for backend API calls.
 * Falls back to http://localhost:4000 in dev / test environments.
 */
function apiBase(): string {
  return (
    process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"
  );
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Send credentials to POST /api/admin/login and persist the returned
 * JWT token + refresh token in localStorage.
 *
 * @param username - Admin username.
 * @param password - Admin password.
 * @returns The token payload (access token, refresh token, expiry).
 * @throws If the server responds with a non-2xx status.
 */
export async function adminLogin(
  username: string,
  password: string,
): Promise<{ token: string; refreshToken: string; expiresIn: number }> {
  const res = await fetch(`${apiBase()}/api/v1/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

  const body = await res.json();

  if (!res.ok) {
    const errMsg =
      body?.error || body?.message || "Login failed. Please try again.";
    throw new Error(errMsg);
  }

  const { token, refreshToken, expiresIn } = body.data;

  try {
    localStorage.setItem(ADMIN_TOKEN_KEY, token);
    if (refreshToken) {
      localStorage.setItem(ADMIN_REFRESH_KEY, refreshToken);
    }
  } catch {
    // localStorage may be unavailable (private browsing, sandboxed iframe)
  }

  return { token, refreshToken, expiresIn };
}

/**
 * Retrieve the stored admin JWT access token.
 *
 * @returns The token string, or `null` if no token exists.
 */
export function getAdminToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_TOKEN_KEY);
  } catch {
    return null;
  }
}

/**
 * Retrieve the stored admin refresh token.
 *
 * @returns The refresh token string, or `null` if no token exists.
 */
function getAdminRefreshToken(): string | null {
  try {
    return localStorage.getItem(ADMIN_REFRESH_KEY);
  } catch {
    return null;
  }
}

/**
 * Returns `true` when a non-empty admin JWT is present in localStorage.
 * Does NOT verify token expiry — that's done server-side.
 */
export function isAdminAuthenticated(): boolean {
  const token = getAdminToken();
  return token !== null && token.length > 0;
}

/**
 * Clear admin tokens from localStorage.
 */
export function adminLogout(): void {
  try {
    localStorage.removeItem(ADMIN_TOKEN_KEY);
    localStorage.removeItem(ADMIN_REFRESH_KEY);
  } catch {
    // localStorage may be unavailable
  }
}

/**
 * Attempt to refresh the admin access token using the stored refresh
 * token. On success, replaces the stored access token.
 *
 * @returns The new access token, or `null` if refresh failed.
 */
export async function refreshAdminToken(): Promise<string | null> {
  const refreshToken = getAdminRefreshToken();
  if (!refreshToken) return null;

  try {
    const res = await fetch(`${apiBase()}/api/v1/admin/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      adminLogout();
      return null;
    }

    const body = await res.json();
    const newToken: string = body.data?.token;

    if (newToken) {
      try {
        localStorage.setItem(ADMIN_TOKEN_KEY, newToken);
      } catch {
        /* ignore */
      }
      return newToken;
    }

    return null;
  } catch {
    adminLogout();
    return null;
  }
}

/**
 * Thin wrapper around `fetch` that injects the admin JWT as a Bearer
 * token in the `Authorization` header.
 *
 * Handles 401 responses by:
 * 1. Attempting a token refresh (once).
 * 2. If refresh fails, clearing tokens and redirecting to `/admin/login`.
 *
 * @param url - Request URL (absolute or relative). If relative, it will
 *   be prefixed with the API base URL.
 * @param options - Standard fetch options (merged with auth header).
 * @returns The `fetch` Response.
 */
export async function adminFetch(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const token = getAdminToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
    "Content-Type": "application/json",
  };

  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const fullUrl = url.startsWith("http") ? url : `${apiBase()}${url}`;

  const res = await fetch(fullUrl, {
    ...options,
    headers,
  });

  // On 401, try a token refresh then retry once
  if (res.status === 401 && token) {
    const newToken = await refreshAdminToken();
    if (newToken) {
      headers["Authorization"] = `Bearer ${newToken}`;
      const retryRes = await fetch(fullUrl, {
        ...options,
        headers,
      });
      if (retryRes.ok) return retryRes;

      // Retry also failed — clear auth and redirect
      adminLogout();
      if (typeof window !== "undefined") {
        window.location.href = "/admin/login";
      }
      return retryRes;
    }

    // Refresh failed — clear auth and redirect
    adminLogout();
    if (typeof window !== "undefined") {
      window.location.href = "/admin/login";
    }
  }

  return res;
}
