"use strict";
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const jwt = require("jsonwebtoken");
const request = require("supertest");

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

// In-memory stand-in for the two session tables. Route tests across this repo
// mock db/pool rather than spin up Postgres; the rotation flow is stateful, so
// this fake keeps the rows instead of replaying a fixed response sequence.
const mockDb = { refreshTokens: [], blacklist: [] };

function mockQuery(sql, values = []) {
  const text = String(sql).replace(/\s+/g, " ").trim();

  if (text.startsWith("INSERT INTO refresh_tokens")) {
    const [id, adminId, tokenHash, family, expiresAt] = values;
    mockDb.refreshTokens.push({
      id,
      admin_id: adminId,
      token_hash: tokenHash,
      family,
      expires_at: expiresAt,
      created_at: new Date(Date.now() + mockDb.refreshTokens.length),
      revoked: false,
      revoked_at: null,
    });
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  if (text.startsWith("SELECT id, admin_id, family, expires_at, revoked FROM refresh_tokens")) {
    const rows = mockDb.refreshTokens.filter((r) => r.token_hash === values[0]);
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  if (text.startsWith("UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE id")) {
    // Honours the `AND revoked = false` predicate: the query is a
    // compare-and-swap, and a caller that matches no row lost the race.
    const row = mockDb.refreshTokens.find(
      (r) => r.id === values[0] && !r.revoked,
    );
    if (row) {
      row.revoked = true;
      row.revoked_at = new Date();
    }
    return Promise.resolve({ rows: [], rowCount: row ? 1 : 0 });
  }

  if (text.startsWith("UPDATE refresh_tokens SET revoked = true, revoked_at = NOW() WHERE family")) {
    const [family, adminId] = values;
    const rows = mockDb.refreshTokens.filter(
      (r) => r.family === family && r.admin_id === adminId && !r.revoked,
    );
    rows.forEach((r) => {
      r.revoked = true;
      r.revoked_at = new Date();
    });
    return Promise.resolve({ rows: [], rowCount: rows.length });
  }

  if (text.startsWith("SELECT family, created_at, expires_at, revoked FROM refresh_tokens")) {
    const rows = mockDb.refreshTokens
      .filter(
        (r) => r.admin_id === values[0] && new Date(r.expires_at) > new Date(),
      )
      .sort((a, b) => a.created_at - b.created_at)
      .map((r) => ({
        family: r.family,
        created_at: r.created_at,
        expires_at: r.expires_at,
        revoked: r.revoked,
      }));
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  if (text.startsWith("SELECT 1 FROM token_blacklist")) {
    const rows = mockDb.blacklist.filter(
      (b) => b.jti === values[0] && new Date(b.expires_at) > new Date(),
    );
    return Promise.resolve({ rows, rowCount: rows.length });
  }

  if (text.startsWith("INSERT INTO token_blacklist")) {
    const [jti, expiresAt] = values;
    if (!mockDb.blacklist.some((b) => b.jti === jti)) {
      mockDb.blacklist.push({ jti, expires_at: expiresAt });
    }
    return Promise.resolve({ rows: [], rowCount: 1 });
  }

  throw new Error(`Unhandled query in fake pool: ${text}`);
}

jest.mock("../db/pool", () => ({
  query: (sql, values) => mockQuery(sql, values),
}));

process.env.ADMIN_USERNAME = "admin";
process.env.ADMIN_PASSWORD = "testpass";
process.env.ADMIN_API_KEY = "test-admin-key";
process.env.JWT_SECRET = "test-secret-for-jest";

const {
  signToken,
  generateAccessToken,
  adminRequired,
  adminKeyRequired,
} = require("../middleware/auth");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use("/api/admin", require("./admin"));
  app.use((err, _req, res, _next) => {
    res.status(err.status || 500).json({ error: err.message });
  });
  return app;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function refreshCookieHeader(res) {
  return (res.headers["set-cookie"] || []).find((c) =>
    c.startsWith("refresh_token="),
  );
}

function refreshCookieValue(res) {
  const header = refreshCookieHeader(res);
  return header ? header.split(";")[0].slice("refresh_token=".length) : null;
}

async function login(app) {
  return request(app)
    .post("/api/admin/login")
    .send({ username: "admin", password: "testpass" });
}

beforeEach(() => {
  mockDb.refreshTokens.length = 0;
  mockDb.blacklist.length = 0;
});

describe("POST /api/admin/login", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 when no credentials are sent", async () => {
    const res = await request(app).post("/api/admin/login").send({});
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong username", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ username: "wrong", password: "testpass" });
    expect(res.status).toBe(401);
  });

  it("returns 401 for wrong password", async () => {
    const res = await request(app)
      .post("/api/admin/login")
      .send({ username: "admin", password: "wrongpass" });
    expect(res.status).toBe(401);
  });

  it("returns 503 when ADMIN_PASSWORD is not configured", async () => {
    delete process.env.ADMIN_PASSWORD;
    const res = await login(app);
    expect(res.status).toBe(503);
    process.env.ADMIN_PASSWORD = "testpass";
  });

  it("returns a 15-minute access token for valid credentials", async () => {
    const res = await login(app);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.expiresIn).toBe(900);
  });

  it("never returns the refresh token in the response body", async () => {
    const res = await login(app);
    expect(res.body.data.refreshToken).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(
      refreshCookieValue(res),
    );
  });

  it("stores only the hash of the refresh token", async () => {
    const res = await login(app);
    const token = refreshCookieValue(res);
    expect(mockDb.refreshTokens).toHaveLength(1);
    expect(mockDb.refreshTokens[0].token_hash).toBe(sha256(token));
    expect(mockDb.refreshTokens[0].token_hash).not.toBe(token);
  });

  it("sets the refresh cookie httpOnly, SameSite=Strict, scoped to /api", async () => {
    const res = await login(app);
    const cookie = refreshCookieHeader(res);
    expect(cookie).toBeDefined();
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api");
  });
});

describe("POST /api/admin/refresh", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 when no refresh cookie is present", async () => {
    const res = await request(app).post("/api/admin/refresh");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown refresh token", async () => {
    const res = await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", "refresh_token=bogus");
    expect(res.status).toBe(401);
  });

  it("issues a new access token and rotates the refresh cookie", async () => {
    const loginRes = await login(app);
    const oldToken = refreshCookieValue(loginRes);

    const res = await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${oldToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.token).toBeDefined();
    expect(res.body.data.expiresIn).toBe(900);

    const newToken = refreshCookieValue(res);
    expect(newToken).toBeDefined();
    expect(newToken).not.toBe(oldToken);
  });

  it("invalidates the previous refresh token after rotation", async () => {
    const loginRes = await login(app);
    const oldToken = refreshCookieValue(loginRes);

    await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${oldToken}`);

    const rows = mockDb.refreshTokens.filter(
      (r) => r.token_hash === sha256(oldToken),
    );
    expect(rows[0].revoked).toBe(true);
  });

  it("keeps the rotated token in the same family", async () => {
    const loginRes = await login(app);
    const oldToken = refreshCookieValue(loginRes);
    const originalFamily = mockDb.refreshTokens[0].family;

    await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${oldToken}`);

    expect(mockDb.refreshTokens).toHaveLength(2);
    expect(mockDb.refreshTokens[1].family).toBe(originalFamily);
  });

  it("revokes every token in the family when a revoked token is reused", async () => {
    const loginRes = await login(app);
    const stolenToken = refreshCookieValue(loginRes);

    // The legitimate holder rotates, which revokes the token the attacker has.
    await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${stolenToken}`);

    const res = await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${stolenToken}`);

    expect(res.status).toBe(401);
    expect(mockDb.refreshTokens).toHaveLength(2);
    expect(mockDb.refreshTokens.every((r) => r.revoked)).toBe(true);
  });

  it("returns 401 for an expired refresh token", async () => {
    const token = "expired-token-value";
    mockDb.refreshTokens.push({
      id: crypto.randomUUID(),
      admin_id: "admin",
      token_hash: sha256(token),
      family: crypto.randomUUID(),
      expires_at: new Date(Date.now() - 1000),
      created_at: new Date(Date.now() - 2000),
      revoked: false,
      revoked_at: null,
    });

    const res = await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${token}`);

    expect(res.status).toBe(401);
  });
});

describe("POST /api/admin/logout", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("blacklists the access token and revokes the session family", async () => {
    const loginRes = await login(app);
    const token = loginRes.body.data.token;
    const refreshToken = refreshCookieValue(loginRes);

    const res = await request(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${token}`)
      .set("Cookie", `refresh_token=${refreshToken}`);

    expect(res.status).toBe(200);
    expect(mockDb.refreshTokens.every((r) => r.revoked)).toBe(true);
    expect(mockDb.blacklist).toHaveLength(1);
    expect(refreshCookieHeader(res)).toContain("refresh_token=;");
  });

  it("succeeds when no session is present", async () => {
    const res = await request(app).post("/api/admin/logout");
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("ignores an access token it did not sign", async () => {
    const forged = jwt.sign(
      { sub: "admin", role: "admin", jti: crypto.randomUUID() },
      "not-the-server-secret",
      { expiresIn: "99y" },
    );

    const res = await request(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${forged}`);

    expect(res.status).toBe(200);
    expect(mockDb.blacklist).toHaveLength(0);
  });
});

describe("GET /api/admin/me", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 without Authorization header", async () => {
    const res = await request(app).get("/api/admin/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 with malformed Authorization header", async () => {
    const res = await request(app)
      .get("/api/admin/me")
      .set("Authorization", "NotBearer token");
    expect(res.status).toBe(401);
  });

  it("returns 401 with expired token", async () => {
    const expired = signToken({ role: "admin" }, "0s");
    await new Promise((r) => setTimeout(r, 100));
    const res = await request(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("returns admin info with valid token", async () => {
    const loginRes = await login(app);
    const res = await request(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${loginRes.body.data.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.username).toBe("admin");
    expect(res.body.data.role).toBe("admin");
  });

  it("rejects an access token that was blacklisted by logout", async () => {
    const loginRes = await login(app);
    const token = loginRes.body.data.token;

    await request(app)
      .post("/api/admin/logout")
      .set("Authorization", `Bearer ${token}`);

    const res = await request(app)
      .get("/api/admin/me")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("TOKEN_REVOKED");
  });
});

describe("GET /api/admin/sessions", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("returns 401 without a token", async () => {
    const res = await request(app).get("/api/admin/sessions");
    expect(res.status).toBe(401);
  });

  it("lists one session per active family and flags the current one", async () => {
    const first = await login(app);
    await login(app);

    const res = await request(app)
      .get("/api/admin/sessions")
      .set("Authorization", `Bearer ${first.body.data.token}`)
      .set("Cookie", `refresh_token=${refreshCookieValue(first)}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.filter((s) => s.current)).toHaveLength(1);
    expect(res.body.data[0]).toHaveProperty("createdAt");
    expect(res.body.data[0]).toHaveProperty("expiresAt");
  });

  it("collapses a rotated family into a single session", async () => {
    const loginRes = await login(app);
    const refreshRes = await request(app)
      .post("/api/admin/refresh")
      .set("Cookie", `refresh_token=${refreshCookieValue(loginRes)}`);

    const res = await request(app)
      .get("/api/admin/sessions")
      .set("Authorization", `Bearer ${refreshRes.body.data.token}`);

    expect(res.body.data).toHaveLength(1);
  });
});

describe("POST /api/admin/sessions/:id/revoke", () => {
  let app;

  beforeEach(() => {
    app = buildApp();
  });

  it("revokes every token in the target family", async () => {
    const keep = await login(app);
    const doomed = await login(app);
    const doomedFamily = mockDb.refreshTokens[1].family;

    const res = await request(app)
      .post(`/api/admin/sessions/${doomedFamily}/revoke`)
      .set("Authorization", `Bearer ${keep.body.data.token}`);

    expect(res.status).toBe(200);
    expect(
      mockDb.refreshTokens.find(
        (r) => r.token_hash === sha256(refreshCookieValue(doomed)),
      ).revoked,
    ).toBe(true);
    expect(
      mockDb.refreshTokens.find(
        (r) => r.token_hash === sha256(refreshCookieValue(keep)),
      ).revoked,
    ).toBe(false);
  });

  it("returns 400 for a malformed session id", async () => {
    const loginRes = await login(app);
    const res = await request(app)
      .post("/api/admin/sessions/not-a-uuid/revoke")
      .set("Authorization", `Bearer ${loginRes.body.data.token}`);
    expect(res.status).toBe(400);
  });

  it("returns 404 for a session that is not active", async () => {
    const loginRes = await login(app);
    const res = await request(app)
      .post(`/api/admin/sessions/${crypto.randomUUID()}/revoke`)
      .set("Authorization", `Bearer ${loginRes.body.data.token}`);
    expect(res.status).toBe(404);
  });
});

describe("adminRequired middleware", () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.get("/protected", adminRequired, (req, res) =>
      res.json({ ok: true, user: req.admin }),
    );
  });

  it("allows requests with a valid access token", async () => {
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${generateAccessToken("admin")}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("rejects a token carrying the legacy refresh payload", async () => {
    const refreshShaped = signToken(
      { role: "admin", sub: "admin", type: "refresh" },
      "1h",
    );
    const res = await request(app)
      .get("/protected")
      .set("Authorization", `Bearer ${refreshShaped}`);
    expect(res.status).toBe(401);
  });

  it("allows requests with valid X-Admin-Key without touching the session tables", async () => {
    const res = await request(app)
      .get("/protected")
      .set("X-Admin-Key", "test-admin-key");
    expect(res.status).toBe(200);
    expect(res.body.user.authMethod).toBe("x-admin-key");
    expect(mockDb.blacklist).toHaveLength(0);
  });
});

describe("adminKeyRequired middleware", () => {
  let app;

  beforeEach(() => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    delete process.env.ADMIN_API_KEYS;
    app = express();
    app.use(express.json());
    app.post("/protected", adminKeyRequired, (req, res) =>
      res.json({ ok: true, user: req.admin }),
    );
  });

  it("rejects requests without X-Admin-Key", async () => {
    const res = await request(app).post("/protected").send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(res.body.error.reason).toBe("Missing X-Admin-Key header");
  });

  it("rejects requests with an invalid X-Admin-Key", async () => {
    const res = await request(app)
      .post("/protected")
      .set("X-Admin-Key", "wrong")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("UNAUTHORIZED");
    expect(res.body.error.reason).toBe("Invalid X-Admin-Key header");
  });

  it("allows requests with the configured X-Admin-Key", async () => {
    const res = await request(app)
      .post("/protected")
      .set("X-Admin-Key", "test-admin-key")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.user.role).toBe("admin");
  });

  it("allows rotated comma-separated keys from ADMIN_API_KEYS", async () => {
    delete process.env.ADMIN_API_KEY;
    process.env.ADMIN_API_KEYS = "old-key, new-key";

    const res = await request(app)
      .post("/protected")
      .set("X-Admin-Key", "new-key")
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
