"use strict";

/**
 * __tests__/middleware/donorAuth.test.js
 *
 * Unit tests for the nonce-based donor authentication (issue #1102, Part A):
 *   - challenge issuance (server-issued, cryptographically random nonces)
 *   - single-use consumption (replay within TTL → "Nonce already consumed")
 *   - method+path binding (cross-endpoint replay → signature mismatch)
 *   - expiry (use after TTL → "Nonce expired")
 *   - legacy timestamp mode behind DONOR_AUTH_LEGACY_TIMESTAMP_MODE=true
 */

const { Keypair } = require("@stellar/stellar-sdk");
const { AppError } = require("../../src/errors");

// ── Stateful in-memory Redis mock ──────────────────────────────────────────
// Mirrors the three donor-auth helpers of src/services/redis.js with a TTL
// wall-clock so expiry semantics are exercised without a real Redis.
jest.mock("../../src/services/redis", () => {
  const store = new Map(); // key -> { value, expiresAt }

  return {
    _store: store,
    storeDonorNonce: jest.fn(async (nonce, ttlMs) => {
      store.set(`nonce:${nonce}`, { value: "1", expiresAt: Date.now() + ttlMs });
      return true;
    }),
    claimDonorNonce: jest.fn(async (nonce, ttlMs) => {
      const k = `consumed:${nonce}`;
      if (store.has(k)) return "consumed";
      store.set(k, { value: "1", expiresAt: Date.now() + ttlMs });
      return "ok";
    }),
    donorNonceIssued: jest.fn(async (nonce) => {
      const entry = store.get(`nonce:${nonce}`);
      if (!entry) return false;
      if (entry.expiresAt <= Date.now()) {
        store.delete(`nonce:${nonce}`);
        return false;
      }
      return true;
    }),
  };
});

const redis = require("../../src/services/redis");
const donorAuth = require("../../src/middleware/donorAuth");

function makeReq(overrides = {}) {
  return {
    method: "GET",
    originalUrl: "/api/donor/stats",
    headers: {},
    ...overrides,
  };
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn(), set: jest.fn() };
}

function makeKeypairAndHeaders(nonce, method, path) {
  const keypair = Keypair.random();
  const payload = donorAuth.buildSignedPayload(nonce, method, path);
  const signature = keypair.sign(payload).toString("hex");
  return {
    keypair,
    headers: {
      "x-donor-address": keypair.publicKey(),
      "x-donor-nonce": nonce,
      "x-donor-signature": signature,
    },
  };
}

/** Drive the middleware and capture the AppError passed to next(). */
function runMiddleware(req) {
  return new Promise((resolve) => {
    donorAuth.requireDonorAuth(req, makeRes(), (err) => resolve(err));
  });
}

describe("donorAuth — nonce mode (default)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    redis._store.clear();
  });

  test("rejects requests missing donor authentication headers", async () => {
    const err = await runMiddleware(makeReq());
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.metadata?.detail).toBe("Missing donor authentication headers");
  });

  test("rejects a malformed nonce", async () => {
    const { headers } = makeKeypairAndHeaders("not-a-nonce", "GET", "/api/donor/stats");
    const err = await runMiddleware(makeReq({ headers }));
    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.metadata?.detail).toBe("Invalid donor nonce");
  });

  test("accepts a valid issued nonce with a matching signature and sets req.donorAddress", async () => {
    const { nonce } = await donorAuth.issueDonorChallenge();
    const { headers, keypair } = makeKeypairAndHeaders(nonce, "GET", "/api/donor/stats");
    const req = makeReq({ headers });

    const err = await runMiddleware(req);

    expect(err).toBeUndefined();
    expect(req.donorAddress).toBe(keypair.publicKey());
    expect(redis.claimDonorNonce).toHaveBeenCalledWith(nonce, donorAuth.NONCE_TTL_MS);
  });

  test("rejects a replay of the same tuple within the TTL window (nonce already consumed)", async () => {
    const { nonce } = await donorAuth.issueDonorChallenge();
    const { headers } = makeKeypairAndHeaders(nonce, "GET", "/api/donor/stats");

    const first = await runMiddleware(makeReq({ headers }));
    expect(first).toBeUndefined();

    const second = await runMiddleware(makeReq({ headers }));
    expect(second).toBeInstanceOf(AppError);
    expect(second.status).toBe(401);
    expect(second.metadata?.detail).toBe("Nonce already consumed");
  });

  test("rejects a signature minted for one endpoint replayed on another (method+path binding)", async () => {
    const { nonce } = await donorAuth.issueDonorChallenge();
    // Signature covers GET /api/donor/stats …
    const { headers } = makeKeypairAndHeaders(nonce, "GET", "/api/donor/stats");
    // … but the attacker replays it on POST /api/donations.
    const req = makeReq({ method: "POST", originalUrl: "/api/donations", headers });

    const err = await runMiddleware(req);

    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.metadata?.detail).toMatch(/method\/path binding mismatch/i);
  });

  test("rejects a valid signature when the nonce has expired (use after TTL)", async () => {
    const { nonce } = await donorAuth.issueDonorChallenge();
    const { headers } = makeKeypairAndHeaders(nonce, "GET", "/api/donor/stats");

    // Simulate the challenge window elapsing: expire the issued marker now.
    redis._store.set(`nonce:${nonce}`, { value: "1", expiresAt: Date.now() - 1 });

    const err = await runMiddleware(makeReq({ headers }));

    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.metadata?.detail).toBe("Nonce expired");
  });

  test("rejects a nonce that was never issued by the challenge endpoint", async () => {
    const { headers } = makeKeypairAndHeaders("a".repeat(64), "GET", "/api/donor/stats");

    const err = await runMiddleware(makeReq({ headers }));

    expect(err).toBeInstanceOf(AppError);
    expect(err.status).toBe(401);
    expect(err.metadata?.detail).toBe("Nonce expired");
  });

  test("issueDonorChallenge returns a 64-hex nonce and ISO expiry, and persists the issued marker", async () => {
    const { nonce, expiresAt } = await donorAuth.issueDonorChallenge();

    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(Number.isNaN(Date.parse(expiresAt))).toBe(false);
    expect(redis.storeDonorNonce).toHaveBeenCalledWith(nonce, donorAuth.NONCE_TTL_MS);
  });

  test("challenges are unique (cryptographically random nonces)", async () => {
    const first = await donorAuth.issueDonorChallenge();
    const second = await donorAuth.issueDonorChallenge();
    expect(first.nonce).not.toBe(second.nonce);
  });

  test("accepts base64-encoded signatures too", async () => {
    const { nonce } = await donorAuth.issueDonorChallenge();
    const keypair = Keypair.random();
    const payload = donorAuth.buildSignedPayload(nonce, "GET", "/api/donor/stats");
    const signature = keypair.sign(payload).toString("base64");

    const req = makeReq({
      headers: {
        "x-donor-address": keypair.publicKey(),
        "x-donor-nonce": nonce,
        "x-donor-signature": signature,
      },
    });

    const err = await runMiddleware(req);
    expect(err).toBeUndefined();
  });
});

describe("donorAuth — legacy timestamp mode", () => {
  let legacyDonorAuth;

  beforeAll(() => {
    process.env.DONOR_AUTH_LEGACY_TIMESTAMP_MODE = "true";
    jest.resetModules();
    legacyDonorAuth = require("../../src/middleware/donorAuth");
  });

  afterAll(() => {
    delete process.env.DONOR_AUTH_LEGACY_TIMESTAMP_MODE;
    jest.resetModules();
  });

  test("verifies the timestamp-only flow when the legacy flag is set", async () => {
    const keypair = Keypair.random();
    const timestamp = String(Date.now());
    const signature = keypair.sign(Buffer.from(timestamp)).toString("hex");
    const req = makeReq({
      headers: {
        "x-donor-address": keypair.publicKey(),
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
    });

    const err = await new Promise((resolve) => {
      legacyDonorAuth.requireDonorAuth(req, makeRes(), resolve);
    });

    expect(err).toBeUndefined();
    expect(req.donorAddress).toBe(keypair.publicKey());
  });

  test("rejects an expired timestamp in legacy mode", async () => {
    // NOTE: after jest.resetModules() the legacy module instance carries its
    // own AppError class, so assert on the shape rather than instanceof.
    const keypair = Keypair.random();
    const timestamp = String(Date.now() - 6 * 60 * 1000); // 6 minutes ago
    const signature = keypair.sign(Buffer.from(timestamp)).toString("hex");
    const req = makeReq({
      headers: {
        "x-donor-address": keypair.publicKey(),
        "x-timestamp": timestamp,
        "x-signature": signature,
      },
    });

    const err = await new Promise((resolve) => {
      legacyDonorAuth.requireDonorAuth(req, makeRes(), resolve);
    });

    expect(err?.status).toBe(401);
  });
});
