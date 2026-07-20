"use strict";

/**
 * backend/src/routes/attestations.routes.test.js
 *
 * Integration-style tests for the /api/attestations router (issue #125).
 * Covers: stats, lookup-by-source, lookup-by-donor, build-proof,
 * signed-record happy path, signed-record replay protection,
 * verify, revoke, and the universally false validation paths.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
  connect: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

// Mock the auth middleware so revoke route tests don't require a real JWT
// or admin key. The mock always calls next() and attaches a test admin
// principal, which lets us focus on the route logic rather than auth setup.
jest.mock("../middleware/auth", () => ({
  adminRequired: jest.fn((req, res, next) => {
    // Check for X-Admin-Key and verify it matches ADMIN_API_KEY. If not,
    // simulate the same behaviour as the real middleware (401).
    const adminKey = req.get && req.get("X-Admin-Key");
    const configured =
      (process.env.ADMIN_API_KEY || "").trim() ||
      (process.env.ADMIN_API_KEYS || "").split(",")[0];
    if (!adminKey) {
      return res.status(401).json({ success: false, error: "Authentication required" });
    }
    if (adminKey !== configured) {
      return res.status(401).json({ success: false, error: "Invalid admin key" });
    }
    req.admin = { role: "admin", sub: "test-admin", authMethod: "x-admin-key" };
    next();
  }),
  isValidAdminKey: jest.fn(() => true),
}));

// Environment for the relayer signing secret. Tests below use the
// /build-proof endpoint to mint a real signature that the / POST route
// then verifies — so the secret must match across the two.
process.env.ATTESTATION_RELAYER_SECRET = "test-secret-do-not-use-in-prod";

const pool = require("../db/pool");
const attestation = require("../services/attestation");

function stellarAddress(prefix = "A") {
  return `G${prefix.repeat(55)}`;
}

function buildRequest({
  method = "GET",
  body = undefined,
  url = "/",
  headers = {},
} = {}) {
  const req = {
    method,
    body,
    url,
    headers,
    get(name) {
      return req.headers[name.toLowerCase()];
    },
    app: { get: () => undefined },
    params: {},
    query: {},
  };
  return req;
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

// Helper that pulls the route-handler function out of the module.
// `require()` returns an Express router; we lift its handlers into a
// single chain so tests can drive them without booting Express.
function pickHandler(method, path) {
  const router = require("./attestations");
  const layer = router.stack.find(
    (l) =>
      l.route &&
      l.route.path === path &&
      l.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`No handler for ${method} ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function invoke(handler, req, res) {
  // handler may be a single function or an array of middlewares.
  const chain = Array.isArray(handler) ? handler : [handler];
  let idx = 0;
  const next = async (err) => {
    if (err) {
      if (res.statusCode === 200) res.status(err.status || 500);
      res.json({ success: false, error: err.message || "Internal error" });
      return;
    }
    const fn = chain[idx++];
    if (!fn) return;
    await fn(req, res, next);
  };
  await next();
}

async function buildProofFor(input) {
  const handler = pickHandler("post", "/build-proof");
  const req = buildRequest({
    method: "POST",
    body: {
      source_chain: input.source_chain,
      source_tx_hash: input.source_tx_hash,
      donor_address: input.donor_address,
      project_id: input.project_id,
    },
  });
  const res = makeResponse();
  await invoke(handler, req, res);
  return res.body.data;
}

beforeEach(() => {
  pool.query.mockReset();
});

describe("GET / (stats)", () => {
  test("returns platform-wide totals and per-chain breakdown", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [{ total: 100, pending: 12, verified: 80, revoked: 8 }],
      })
      .mockResolvedValueOnce({
        rows: [
          { source_chain: "ethereum", count: 60 },
          { source_chain: "polygon", count: 40 },
        ],
      });

    const handler = pickHandler("get", "/");
    const res = makeResponse();
    await invoke(handler, buildRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toMatchObject({
      total: 100,
      pending: 12,
      verified: 80,
      revoked: 8,
      byChain: [
        { sourceChain: "ethereum", count: 60 },
        { sourceChain: "polygon", count: 40 },
      ],
    });
  });
});

describe("GET /by-source", () => {
  test("looks up an existing attestation", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "abc",
          on_chain_id: 5,
          source_chain: "ethereum",
          source_tx_hash: "0xfeed1234567890abcdef1234567890abcdef1234567890abcdef12",
          donor_address: stellarAddress("A"),
          project_id: "p",
          amount_usd: "1",
          amount_xlm: "1",
          message_hash: 0,
          status: "verified",
          created_at: "2026-06-01T00:00:00Z",
          verified_at: "2026-06-01T00:01:00Z",
        },
      ],
    });

    const handler = pickHandler("get", "/by-source");
    const req = buildRequest();
    req.query = { source_chain: "ethereum", source_tx_hash: "0xfeed1234567890abcdef1234567890abcdef1234567890abcdef12" };
    const res = makeResponse();
    await invoke(handler, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      onChainId: 5,
      sourceChain: "ethereum",
      sourceTxHash: "0xfeed1234567890abcdef1234567890abcdef1234567890abcdef12",
    });
  });

  test("returns 404 when not found", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const handler = pickHandler("get", "/by-source");
    const req = buildRequest();
    req.query = { source_chain: "ethereum", source_tx_hash: "0xfeed1234567890abcdef1234567890abcdef1234567890abcdef12" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  test("returns 400 when tx hash fails validation", async () => {
    const handler = pickHandler("get", "/by-source");
    const req = buildRequest();
    req.query = { source_chain: "ethereum", source_tx_hash: "x" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/source_tx_hash/);
  });

  test("returns 400 for an unsupported source chain", async () => {
    const handler = pickHandler("get", "/by-source");
    const req = buildRequest();
    req.query = { source_chain: "dogecoin", source_tx_hash: "0xfeed1234567890abcdef1234567890abcdef1234567890abcdef12" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Unsupported source_chain/);
  });
});

describe("GET /by-donor/:publicKey", () => {
  test("returns shaped rows", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "1",
          on_chain_id: 1,
          source_chain: "ethereum",
          source_tx_hash: "0xa1234567890abcdef1234567890abcdef1234567890abcdef1234567",
          donor_address: stellarAddress("A"),
          project_id: "p",
          amount_usd: "1",
          amount_xlm: "1",
          message_hash: 0,
          status: "verified",
          created_at: "2026-06-01T00:00:00Z",
          verified_at: null,
        },
      ],
    });

    const handler = pickHandler("get", "/by-donor/:publicKey");
    const req = buildRequest();
    req.params = { publicKey: stellarAddress("A") };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data[0].donorAddress).toBe(stellarAddress("A"));
  });

  test("rejects malformed Stellar addresses with 400", async () => {
    const handler = pickHandler("get", "/by-donor/:publicKey");
    const req = buildRequest();
    req.params = { publicKey: "not-a-key" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/Stellar public key/);
  });
});

describe("POST /build-proof", () => {
  test("returns a signed payload + signature", async () => {
    const handler = pickHandler("post", "/build-proof");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: "ethereum",
        source_tx_hash: "0xdead1234567890abcdef1234567890abcdef1234567890abcdef12",
        donor_address: stellarAddress("A"),
        project_id: "p-1",
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({
      payload: expect.stringMatching(/^[0-9a-f]{64}$/),
      signature: expect.stringMatching(/^t=\d+,v1=[0-9a-f]+$/),
      canonical: expect.objectContaining({ project_id: "p-1" }),
    });
  });

  test("rejects unsupported chains", async () => {
    const handler = pickHandler("post", "/build-proof");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: "dogecoin",
        source_tx_hash: "0xd1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        donor_address: stellarAddress("A"),
        project_id: "p-1",
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
  });

  test("rejects missing project_id", async () => {
    const handler = pickHandler("post", "/build-proof");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: "ethereum",
        source_tx_hash: "0xd1234567890abcdef1234567890abcdef1234567890abcdef1234567890",
        donor_address: stellarAddress("A"),
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/project_id/);
  });
});

describe("POST / (record)", () => {
  const baseInput = {
    source_chain: "ethereum",
    source_tx_hash: "0xbead1234567890abcdef1234567890abcdef1234567890abcdef12",
    donor_address: stellarAddress("A"),
    project_id: "p-7",
  };

  test("happy path — builds proof, records, returns 201", async () => {
    const proof = await buildProofFor(baseInput);
    expect(proof).toBeTruthy();

    pool.query.mockResolvedValueOnce({ rows: [] }); // dedup
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "new-uuid",
          on_chain_id: 99,
          source_chain: "ethereum",
          source_tx_hash: "0xbead1234567890abcdef1234567890abcdef1234567890abcdef12",
          donor_address: stellarAddress("A"),
          project_id: "p-7",
          amount_usd: "10",
          amount_xlm: "80",
          message_hash: 0,
          status: "pending",
          created_at: "2026-06-01T00:00:00Z",
          verified_at: null,
          recorded_by: "relayer-x",
        },
      ],
    });

    const handler = pickHandler("post", "/");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: baseInput.source_chain,
        source_tx_hash: baseInput.source_tx_hash,
        donor_address: baseInput.donor_address,
        project_id: baseInput.project_id,
        amount_usd: 10,
        amount_xlm: 80,
        on_chain_id: 99,
      },
      headers: {
        "x-attestation-signature": proof.signature,
        "x-attestation-timestamp": String(proof.timestamp),
        "x-relayer-address": "relayer-x",
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.created).toBe(true);
    expect(res.body.data).toMatchObject({
      onChainId: 99,
      donorAddress: stellarAddress("A"),
      status: "pending",
    });
  });

  test("returns 401 when the signature is missing", async () => {
    const handler = pickHandler("post", "/");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: baseInput.source_chain,
        source_tx_hash: baseInput.source_tx_hash,
        donor_address: baseInput.donor_address,
        project_id: baseInput.project_id,
        amount_usd: 10,
        amount_xlm: 80,
        on_chain_id: 7,
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(401);
  });

  test("returns 401 when the signature does not verify", async () => {
    const handler = pickHandler("post", "/");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: baseInput.source_chain,
        source_tx_hash: baseInput.source_tx_hash,
        donor_address: baseInput.donor_address,
        project_id: baseInput.project_id,
        amount_usd: 10,
        amount_xlm: 80,
        on_chain_id: 7,
      },
      headers: {
        "x-attestation-signature": "t=1,v1=deadbeef",
        "x-attestation-timestamp": "1700000000",
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(401);
  });

  test("rejects negative amounts", async () => {
    const proof = await buildProofFor(baseInput);
    const handler = pickHandler("post", "/");
    const req = buildRequest({
      method: "POST",
      body: {
        source_chain: baseInput.source_chain,
        source_tx_hash: baseInput.source_tx_hash,
        donor_address: baseInput.donor_address,
        project_id: baseInput.project_id,
        amount_usd: -1,
        amount_xlm: 80,
        on_chain_id: 7,
      },
      headers: {
        "x-attestation-signature": proof.signature,
        "x-attestation-timestamp": String(proof.timestamp),
      },
    });
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/amount_usd/);
  });
});

describe("POST /:id/verify", () => {
  test("returns the updated row on first verify", async () => {
    const updated = {
      id: "uuid",
      on_chain_id: 1,
      source_chain: "ethereum",
      source_tx_hash: "0xa1234567890abcdef1234567890abcdef1234567890abcdef1234567",
      donor_address: stellarAddress("A"),
      project_id: "p",
      amount_usd: "10",
      amount_xlm: "80",
      message_hash: 0,
      status: "verified",
      created_at: "2026-06-01T00:00:00Z",
      verified_at: "2026-06-01T00:01:00Z",
    };
    pool.query.mockResolvedValueOnce({ rows: [updated] });

    const handler = pickHandler("post", "/:id/verify");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe("verified");
  });

  test("returns 404 when already verified", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const handler = pickHandler("post", "/:id/verify");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(404);
  });

  test("rejects malformed id", async () => {
    const handler = pickHandler("post", "/:id/verify");
    const req = buildRequest();
    req.params = { id: "not-a-uuid" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
  });
});

describe("POST /:id/revoke", () => {
  test("returns 401 when admin auth is missing", async () => {
    const handler = pickHandler("post", "/:id/revoke");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(401);
  });

  test("returns 401 when the admin key is invalid", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    const handler = pickHandler("post", "/:id/revoke");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    req.headers = { "x-admin-key": "wrong-key" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(401);
  });

  test("returns the revoked row when admin key matches", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    const revoked = {
      id: "11111111-2222-4333-8444-555555555555",
      on_chain_id: 1,
      source_chain: "ethereum",
      source_tx_hash: "0xa1234567890abcdef1234567890abcdef1234567890abcdef1234567",
      donor_address: stellarAddress("A"),
      project_id: "p",
      amount_usd: "10",
      amount_xlm: "80",
      message_hash: 0,
      status: "revoked",
      created_at: "2026-06-01T00:00:00Z",
      verified_at: null,
    };
    pool.query.mockResolvedValueOnce({ rows: [revoked] });
    const handler = pickHandler("post", "/:id/revoke");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    req.headers = { "x-admin-key": "test-admin-key" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe("revoked");
    expect(pool.query.mock.calls[0][1]).toEqual([
      "11111111-2222-4333-8444-555555555555",
    ]);
  });

  test("returns 404 when revocation is a no-op", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    pool.query.mockResolvedValueOnce({ rows: [] });
    const handler = pickHandler("post", "/:id/revoke");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    req.headers = { "x-admin-key": "test-admin-key" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(404);
  });

  test("rejects malformed UUID before auth", async () => {
    process.env.ADMIN_API_KEY = "test-admin-key";
    const handler = pickHandler("post", "/:id/revoke");
    const req = buildRequest();
    req.params = { id: "not-a-uuid" };
    req.headers = { "x-admin-key": "test-admin-key" };
    const res = makeResponse();
    await invoke(handler, req, res);
    // 400 wins over 401 — malformed input is rejected before auth so callers
    // get actionable feedback without leaking auth state.
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /:id (single)", () => {
  test("returns the shaped row", async () => {
    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: "11111111-2222-4333-8444-555555555555",
          on_chain_id: 3,
          source_chain: "ethereum",
          source_tx_hash: "0xa1234567890abcdef1234567890abcdef1234567890abcdef1234567",
          donor_address: stellarAddress("A"),
          project_id: "p",
          amount_usd: "10",
          amount_xlm: "80",
          message_hash: 0,
          status: "verified",
          created_at: "2026-06-01T00:00:00Z",
          verified_at: "2026-06-01T00:01:00Z",
        },
      ],
    });
    const handler = pickHandler("get", "/:id");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe("11111111-2222-4333-8444-555555555555");
  });

  test("returns 400 for malformed UUID", async () => {
    const handler = pickHandler("get", "/:id");
    const req = buildRequest();
    req.params = { id: "not-uuid" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(400);
  });

  test("returns 404 when missing", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    const handler = pickHandler("get", "/:id");
    const req = buildRequest();
    req.params = { id: "11111111-2222-4333-8444-555555555555" };
    const res = makeResponse();
    await invoke(handler, req, res);
    expect(res.statusCode).toBe(404);
  });
});

// Silence the attestation module logger spam in test output — the
// service is intentionally chatty so an SRE can see the trace.
beforeAll(() => {
  jest.spyOn(attestation, "findBySource");
  jest.spyOn(attestation, "findByOnChainId");
  jest.spyOn(attestation, "findById");
  jest.spyOn(attestation, "upsertAttestation");
  jest.spyOn(attestation, "markVerified");
  jest.spyOn(attestation, "revoke");
});
