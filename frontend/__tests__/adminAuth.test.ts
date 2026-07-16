/**
 * __tests__/adminAuth.test.ts — Unit tests for lib/adminAuth.ts
 *
 * Covers: adminLogin, getAdminToken, isAdminAuthenticated, adminLogout,
 * adminFetch header injection, and token refresh/401 handling.
 *
 * @jest-environment jsdom
 */
import {
  adminLogin,
  getAdminToken,
  isAdminAuthenticated,
  adminLogout,
  adminFetch,
  refreshAdminToken,
} from "@/lib/adminAuth";

const TOKEN_KEY = "indigopay:adminToken";
const REFRESH_KEY = "indigopay:adminRefreshToken";
const API_BASE = "http://localhost:4000";

const MOCK_TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiJ9.mock";
const MOCK_REFRESH = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.refresh";

// Helper: create a mock fetch Response object
function mockFetchResponse(
  body: unknown,
  init?: { status?: number; headers?: Record<string, string> },
) {
  return {
    ok: init?.status ? init.status >= 200 && init.status < 300 : true,
    status: init?.status ?? 200,
    headers: init?.headers ?? {},
    json: () => Promise.resolve(body),
  };
}

beforeEach(() => {
  jest.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* noop */
  }
});

// ── adminLogin ────────────────────────────────────────────────────────

describe("adminLogin", () => {
  it("stores tokens on successful login", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: {
          token: MOCK_TOKEN,
          refreshToken: MOCK_REFRESH,
          expiresIn: 3600,
        },
      }),
    );
    global.fetch = mockFetch;

    const result = await adminLogin("admin", "password123");
    expect(result.token).toBe(MOCK_TOKEN);
    expect(result.refreshToken).toBe(MOCK_REFRESH);
    expect(result.expiresIn).toBe(3600);

    expect(localStorage.getItem(TOKEN_KEY)).toBe(MOCK_TOKEN);
    expect(localStorage.getItem(REFRESH_KEY)).toBe(MOCK_REFRESH);

    // Verify the fetch call
    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/admin/login`,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "password123" }),
      }),
    );
  });

  it("throws on invalid credentials", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse(
        {
          success: false,
          error: "Invalid credentials",
        },
        { status: 401 },
      ),
    );

    await expect(adminLogin("admin", "wrong")).rejects.toThrow(
      "Invalid credentials",
    );
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it("throws on server error (503)", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse(
        {
          success: false,
          error: "Admin authentication not configured on this server",
        },
        { status: 503 },
      ),
    );

    await expect(adminLogin("admin", "pass")).rejects.toThrow(
      "Admin authentication not configured on this server",
    );
  });

  it("throws with a fallback message when response body is empty", async () => {
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse(null, { status: 500 }),
    );

    await expect(adminLogin("admin", "pass")).rejects.toThrow(
      "Login failed. Please try again.",
    );
  });
});

// ── getAdminToken / isAdminAuthenticated / adminLogout ────────────────

describe("token helpers", () => {
  it("getAdminToken returns null when no token is stored", () => {
    expect(getAdminToken()).toBeNull();
  });

  it("getAdminToken returns the stored token", () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    expect(getAdminToken()).toBe(MOCK_TOKEN);
  });

  it("isAdminAuthenticated returns false when no token", () => {
    expect(isAdminAuthenticated()).toBe(false);
  });

  it("isAdminAuthenticated returns true when token exists", () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    expect(isAdminAuthenticated()).toBe(true);
  });

  it("isAdminAuthenticated returns false for empty string token", () => {
    localStorage.setItem(TOKEN_KEY, "");
    expect(isAdminAuthenticated()).toBe(false);
  });

  it("adminLogout clears both tokens", () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    localStorage.setItem(REFRESH_KEY, MOCK_REFRESH);
    adminLogout();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});

// ── adminFetch ────────────────────────────────────────────────────────

describe("adminFetch", () => {
  it("injects Bearer token header when token is present", async () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);

    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({ success: true, data: [] }),
    );
    global.fetch = mockFetch;

    await adminFetch("/api/v1/verification-requests");

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/verification-requests`,
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Bearer ${MOCK_TOKEN}`,
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("sends request without auth header when no token", async () => {
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({ success: true, data: [] }),
    );
    global.fetch = mockFetch;

    await adminFetch("/api/v1/verification-requests");

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/verification-requests`,
      expect.objectContaining({
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    // The header should NOT contain Authorization
    const callHeaders = (mockFetch.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(callHeaders["Authorization"]).toBeUndefined();
  });

  it("handles 401 by clearing token and redirecting when refresh fails", async () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);

    // First call returns 401
    const mockFetch = jest
      .fn()
      .mockResolvedValueOnce(
        mockFetchResponse({ error: "Unauthorized" }, { status: 401 }),
      )
      // Refresh attempt also fails (no refresh token stored)
      .mockResolvedValueOnce(
        mockFetchResponse({ error: "Invalid refresh token" }, { status: 401 }),
      );
    global.fetch = mockFetch;

    const res = await adminFetch("/api/v1/verification-requests");

    expect(res.status).toBe(401);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    // jsdom does not implement navigation (except hash changes), so we
    // verify the behaviour indirectly: token was cleared (above) and the
    // response was returned. The redirect logic was executed.
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });

  it("retries request after successful token refresh on 401", async () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    localStorage.setItem(REFRESH_KEY, MOCK_REFRESH);

    const NEW_TOKEN = "new.jwt.token";
    let callCount = 0;

    const mockFetch = jest.fn().mockImplementation(
      async (url: RequestInfo | URL, _init?: RequestInit) => {
        const urlStr = url.toString();
        callCount++;

        // First call returns 401
        if (callCount === 1 && urlStr.includes("/verification-requests")) {
          return mockFetchResponse({ error: "Unauthorized" }, { status: 401 });
        }

        // Second call: refresh endpoint
        if (urlStr.includes("/admin/refresh")) {
          return mockFetchResponse({
            success: true,
            data: { token: NEW_TOKEN },
          });
        }

        // Third call: retry with new token
        return mockFetchResponse({ success: true, data: [{ id: "test" }] });
      },
    );
    global.fetch = mockFetch;

    const res = await adminFetch("/api/v1/verification-requests");

    expect(res.ok).toBe(true);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(NEW_TOKEN);
    expect(callCount).toBe(3);
  });
});

// ── refreshAdminToken ─────────────────────────────────────────────────

describe("refreshAdminToken", () => {
  it("returns null when no refresh token is stored", async () => {
    const result = await refreshAdminToken();
    expect(result).toBeNull();
  });

  it("successfully refreshes token and stores the new one", async () => {
    localStorage.setItem(REFRESH_KEY, MOCK_REFRESH);
    const NEW_TOKEN = "refreshed.jwt.token";

    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: NEW_TOKEN },
      }),
    );

    const result = await refreshAdminToken();
    expect(result).toBe(NEW_TOKEN);
    expect(localStorage.getItem(TOKEN_KEY)).toBe(NEW_TOKEN);
  });

  it("clears tokens and returns null when refresh fails", async () => {
    localStorage.setItem(TOKEN_KEY, MOCK_TOKEN);
    localStorage.setItem(REFRESH_KEY, MOCK_REFRESH);

    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({ error: "Invalid token" }, { status: 401 }),
    );

    const result = await refreshAdminToken();
    expect(result).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem(REFRESH_KEY)).toBeNull();
  });
});
