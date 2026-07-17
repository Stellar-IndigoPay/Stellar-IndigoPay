/**
 * __tests__/adminAuth.test.ts — Unit tests for lib/adminAuth.ts
 *
 * Covers: adminLogin, in-memory token handling, ensureAdminSession
 * rehydration, single-flight refresh, adminLogout, and adminFetch 401
 * handling.
 *
 * @jest-environment jsdom
 */
const API_BASE = "http://localhost:4000";

const MOCK_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiJ9.mock";

// Helper: create a mock fetch Response object
function mockFetchResponse(
  body: unknown,
  init?: { status?: number },
) {
  return {
    ok: init?.status ? init.status >= 200 && init.status < 300 : true,
    status: init?.status ?? 200,
    json: () => Promise.resolve(body),
  };
}

type AdminAuth = typeof import("@/lib/adminAuth");

// The access token lives in module scope, so each test gets a fresh module
// rather than a shared session leaking across cases.
function loadAdminAuth(): AdminAuth {
  let mod!: AdminAuth;
  jest.isolateModules(() => {
    mod = require("@/lib/adminAuth");
  });
  return mod;
}

beforeEach(() => {
  jest.restoreAllMocks();
});

// ── adminLogin ────────────────────────────────────────────────────────

describe("adminLogin", () => {
  it("keeps the access token in memory and sends credentials for the cookie", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    global.fetch = mockFetch;

    const result = await auth.adminLogin("admin", "password123");

    expect(result.token).toBe(MOCK_TOKEN);
    expect(result.expiresIn).toBe(900);
    expect(auth.getAdminToken()).toBe(MOCK_TOKEN);

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/admin/login`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        body: JSON.stringify({ username: "admin", password: "password123" }),
      }),
    );
  });

  it("never writes the token to localStorage", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    const setItem = jest.spyOn(Storage.prototype, "setItem");

    await auth.adminLogin("admin", "password123");

    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
  });

  // Envelope shape mirrors AppError#toJSON in backend/src/errors.js: `message`
  // is canonical per code, `reason` is what the call site rejected.
  it("surfaces the reason, not the canonical message, on a wrong password", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Authentication required",
            reason: "Invalid credentials",
          },
        },
        { status: 401 },
      ),
    );

    await expect(auth.adminLogin("admin", "wrong")).rejects.toThrow(
      "Invalid credentials",
    );
    expect(auth.getAdminToken()).toBeNull();
  });

  it("falls back to the canonical message when there is no reason", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse(
        { error: { code: "RATE_LIMITED", message: "Too many requests" } },
        { status: 429 },
      ),
    );

    await expect(auth.adminLogin("admin", "pass")).rejects.toThrow(
      "Too many requests",
    );
  });

  it("throws a fallback message when the response body is empty", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockFetchResponse(null, { status: 500 }));

    await expect(auth.adminLogin("admin", "pass")).rejects.toThrow(
      "Login failed. Please try again.",
    );
  });

  it("surfaces the 503 reason when admin auth is not configured", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            message: "Service temporarily unavailable",
            reason: "Admin authentication not configured on this server",
          },
        },
        { status: 503 },
      ),
    );

    await expect(auth.adminLogin("admin", "pass")).rejects.toThrow(
      "Admin authentication not configured on this server",
    );
  });
});

// ── token helpers ─────────────────────────────────────────────────────

describe("token helpers", () => {
  it("getAdminToken returns null before a session exists", () => {
    const auth = loadAdminAuth();
    expect(auth.getAdminToken()).toBeNull();
  });

  it("isAdminAuthenticated reflects the in-memory token", async () => {
    const auth = loadAdminAuth();
    expect(auth.isAdminAuthenticated()).toBe(false);

    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    await auth.adminLogin("admin", "pass");

    expect(auth.isAdminAuthenticated()).toBe(true);
  });
});

// ── ensureAdminSession ────────────────────────────────────────────────

describe("ensureAdminSession", () => {
  it("rehydrates from the refresh cookie when no token is loaded", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({ success: true, data: { token: "restored.token" } }),
    );
    global.fetch = mockFetch;

    await expect(auth.ensureAdminSession()).resolves.toBe(true);
    expect(auth.getAdminToken()).toBe("restored.token");
    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/admin/refresh`,
      expect.objectContaining({ method: "POST", credentials: "include" }),
    );
  });

  it("resolves false when the refresh cookie is gone", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockFetchResponse({ error: "no" }, { status: 401 }));

    await expect(auth.ensureAdminSession()).resolves.toBe(false);
    expect(auth.getAdminToken()).toBeNull();
  });

  it("does not call refresh when a token is already loaded", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    global.fetch = mockFetch;
    await auth.adminLogin("admin", "pass");
    mockFetch.mockClear();

    await expect(auth.ensureAdminSession()).resolves.toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ── refreshAdminToken ─────────────────────────────────────────────────

describe("refreshAdminToken", () => {
  it("collapses concurrent callers into a single request", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({ success: true, data: { token: "rotated.token" } }),
    );
    global.fetch = mockFetch;

    const results = await Promise.all([
      auth.refreshAdminToken(),
      auth.refreshAdminToken(),
      auth.refreshAdminToken(),
    ]);

    expect(results).toEqual(["rotated.token", "rotated.token", "rotated.token"]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("allows a new request once the previous one settled", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({ success: true, data: { token: "rotated.token" } }),
    );
    global.fetch = mockFetch;

    await auth.refreshAdminToken();
    await auth.refreshAdminToken();

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns null and clears the token when refresh fails", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest
      .fn()
      .mockResolvedValue(mockFetchResponse({ error: "gone" }, { status: 401 }));

    await expect(auth.refreshAdminToken()).resolves.toBeNull();
    expect(auth.getAdminToken()).toBeNull();
  });
});

// ── adminLogout ───────────────────────────────────────────────────────

describe("adminLogout", () => {
  it("revokes the session server-side and drops the local token", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    global.fetch = mockFetch;
    await auth.adminLogin("admin", "pass");
    mockFetch.mockClear();

    await auth.adminLogout();

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/admin/logout`,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: { Authorization: `Bearer ${MOCK_TOKEN}` },
      }),
    );
    expect(auth.getAdminToken()).toBeNull();
  });

  it("still clears the token when the logout call fails", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    await auth.adminLogin("admin", "pass");

    global.fetch = jest.fn().mockRejectedValue(new Error("network down"));
    await auth.adminLogout();

    expect(auth.getAdminToken()).toBeNull();
  });
});

// ── adminFetch ────────────────────────────────────────────────────────

describe("adminFetch", () => {
  it("attaches the access token and includes the cookie", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest.fn().mockResolvedValue(
      mockFetchResponse({
        success: true,
        data: { token: MOCK_TOKEN, expiresIn: 900 },
      }),
    );
    global.fetch = mockFetch;
    await auth.adminLogin("admin", "pass");
    mockFetch.mockClear();
    mockFetch.mockResolvedValue(mockFetchResponse({ success: true, data: [] }));

    await auth.adminFetch("/api/v1/verification-requests");

    expect(mockFetch).toHaveBeenCalledWith(
      `${API_BASE}/api/v1/verification-requests`,
      expect.objectContaining({
        credentials: "include",
        headers: expect.objectContaining({
          Authorization: `Bearer ${MOCK_TOKEN}`,
          "Content-Type": "application/json",
        }),
      }),
    );
  });

  it("sends no Authorization header when no token is loaded", async () => {
    const auth = loadAdminAuth();
    const mockFetch = jest
      .fn()
      .mockResolvedValue(mockFetchResponse({ success: true, data: [] }));
    global.fetch = mockFetch;

    await auth.adminFetch("/api/v1/verification-requests");

    const callHeaders = (mockFetch.mock.calls[0][1] as RequestInit)
      .headers as Record<string, string>;
    expect(callHeaders["Authorization"]).toBeUndefined();
  });

  it("refreshes once and retries after a 401", async () => {
    const auth = loadAdminAuth();
    const NEW_TOKEN = "new.jwt.token";
    let callCount = 0;

    const mockFetch = jest.fn().mockImplementation(async (url: string) => {
      callCount++;
      if (url.includes("/admin/refresh")) {
        return mockFetchResponse({ success: true, data: { token: NEW_TOKEN } });
      }
      if (callCount === 1) {
        return mockFetchResponse({ error: "Unauthorized" }, { status: 401 });
      }
      return mockFetchResponse({ success: true, data: [{ id: "test" }] });
    });
    global.fetch = mockFetch;

    const res = await auth.adminFetch("/api/v1/verification-requests");

    expect(res.ok).toBe(true);
    expect(auth.getAdminToken()).toBe(NEW_TOKEN);
    expect(callCount).toBe(3);
  });

  it("clears the session when the refresh after a 401 fails", async () => {
    const auth = loadAdminAuth();
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        mockFetchResponse({ error: "Unauthorized" }, { status: 401 }),
      );

    const res = await auth.adminFetch("/api/v1/verification-requests");

    expect(res.status).toBe(401);
    expect(auth.getAdminToken()).toBeNull();
  });
});
