"use strict";

/**
 * backend/src/services/attestation.test.js
 *
 * Unit tests for the off-chain attestation layer (issue #125).
 * No DB connection is opened — `pool` is fully mocked. The HMAC
 * signing defensively uses a deterministic secret so the signature is
 * reproducible without leaking the production secret.
 */

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const pool = require("../db/pool");
const attestation = require("./attestation");

// A stable per-test crypto so signatures are reproducible between runs.
process.env.ATTESTATION_RELAYER_SECRET =
  process.env.ATTESTATION_RELAYER_SECRET || "test-secret-do-not-use-in-prod";

const SAMPLE_INPUT = {
  source_chain: "ethereum",
  source_tx_hash: "0xabc123",
  donor: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  project_id: "climate-trees",
};

function stellarAddress(prefix = "A") {
  return `G${prefix.repeat(55)}`;
}

describe("computeAttestationHash", () => {
  test("is deterministic", () => {
    const a = attestation.computeAttestationHash(SAMPLE_INPUT);
    const b = attestation.computeAttestationHash(SAMPLE_INPUT);
    expect(a).toEqual(b);
    expect(a).toHaveLength(64); // sha256 hex length
  });

  test("changes when any field changes", () => {
    const base = attestation.computeAttestationHash(SAMPLE_INPUT);
    expect(attestation.computeAttestationHash({ ...SAMPLE_INPUT, donor: stellarAddress("B") })).not.toEqual(base);
    expect(attestation.computeAttestationHash({ ...SAMPLE_INPUT, project_id: "other" })).not.toEqual(base);
    expect(attestation.computeAttestationHash({ ...SAMPLE_INPUT, source_chain: "polygon" })).not.toEqual(base);
    expect(attestation.computeAttestationHash({ ...SAMPLE_INPUT, source_tx_hash: "0xdeadbeef" })).not.toEqual(base);
  });
});

describe("buildAttestationProof + verifyAttestationProof", () => {
  test("round-trips", () => {
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = attestation.buildAttestationProof(
      SAMPLE_INPUT,
      process.env.ATTESTATION_RELAYER_SECRET,
      ts,
    );
    expect(
      attestation.verifyAttestationProof(
        SAMPLE_INPUT,
        process.env.ATTESTATION_RELAYER_SECRET,
        signature,
        ts,
      ),
    ).toBe(true);
  });

  test("refuses to mint a proof when the secret is missing", () => {
    expect(() => attestation.buildAttestationProof(SAMPLE_INPUT, "", 1700_000_000)).toThrow(
      /ATTESTATION_RELAYER_SECRET/,
    );
    expect(() =>
      attestation.buildAttestationProof(SAMPLE_INPUT, undefined, 1700_000_000),
    ).toThrow(/ATTESTATION_RELAYER_SECRET/);
  });

  test("rejects when the donor field is tampered", () => {
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = attestation.buildAttestationProof(
      SAMPLE_INPUT,
      process.env.ATTESTATION_RELAYER_SECRET,
      ts,
    );
    expect(
      attestation.verifyAttestationProof(
        { ...SAMPLE_INPUT, donor: stellarAddress("B") },
        process.env.ATTESTATION_RELAYER_SECRET,
        signature,
        ts,
      ),
    ).toBe(false);
  });

  test("rejects when the timestamp is outside the replay window", () => {
    const ts = 1_700_000_000;
    const { signature } = attestation.buildAttestationProof(
      SAMPLE_INPUT,
      process.env.ATTESTATION_RELAYER_SECRET,
      ts,
    );
    expect(
      attestation.verifyAttestationProof(
        SAMPLE_INPUT,
        process.env.ATTESTATION_RELAYER_SECRET,
        signature,
        ts + 60 * 60, // 1h later
      ),
    ).toBe(false);
  });
});

describe("validators", () => {
  test("accepts whitelisted source chains", () => {
    expect(() => attestation.assertValidSourceChain("ethereum")).not.toThrow();
    expect(() => attestation.assertValidSourceChain("ETHEREUM")).not.toThrow();
  });

  test("rejects unsupported source chains", () => {
    expect(() => attestation.assertValidSourceChain("dogecoin")).toThrow(
      /Unsupported source_chain/,
    );
  });

  test("rejects invalid tx hashes", () => {
    expect(() => attestation.assertValidTxHash("")).toThrow();
    expect(() => attestation.assertValidTxHash("tooshort")).toThrow();
    expect(() => attestation.assertValidTxHash("0x" + "a".repeat(129))).toThrow();
  });

  test("accepts a 40-char (lower-bound) tx hash", () => {
    expect(() => attestation.assertValidTxHash("a".repeat(40))).not.toThrow();
  });

  test("rejects non-Stellar addresses", () => {
    expect(() => attestation.assertValidStellarAddress("1234")).toThrow();
    expect(() =>
      attestation.assertValidStellarAddress("S" + "A".repeat(55)),
    ).toThrow();
  });

  test("accepts a valid Stellar address", () => {
    expect(
      attestation.assertValidStellarAddress(stellarAddress("A")),
    ).toEqual(stellarAddress("A"));
  });
});

describe("upsertAttestation", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test("returns the existing row when the source tx is already attested", async () => {
    const existing = {
      id: "existing-uuid",
      on_chain_id: 1,
      source_chain: "ethereum",
      source_tx_hash: "0xabc",
      donor_address: stellarAddress("A"),
      project_id: "project-x",
      amount_usd: "10.0",
      amount_xlm: "80.0",
      message_hash: 0,
      status: "pending",
      created_at: new Date().toISOString(),
      verified_at: null,
      recorded_by: null,
    };
    pool.query.mockResolvedValueOnce({ rows: [existing] });

    const input = {
      on_chain_id: 1,
      source_chain: "ethereum",
      source_tx_hash: "0xabc",
      donor_address: stellarAddress("A"),
      project_id: "project-x",
      amount_usd: 10,
      amount_xlm: 80,
    };
    const result = await attestation.upsertAttestation(input);

    expect(result.created).toBe(false);
    expect(result.row).toEqual(existing);
    // Second INSERT never happens.
    expect(pool.query.mock.calls.length).toBe(1);
  });

  test("returns the existing row after a 23505 race", async () => {
    const existing = {
      id: "race-uuid",
      on_chain_id: 7,
      source_chain: "polygon",
      source_tx_hash: "0xbeef",
      donor_address: stellarAddress("B"),
      project_id: "project-y",
      amount_usd: "5.0",
      amount_xlm: "40.0",
      message_hash: 0,
      status: "pending",
      created_at: new Date().toISOString(),
      verified_at: null,
      recorded_by: null,
    };
    // 1st call: dedup lookup → none
    pool.query.mockResolvedValueOnce({ rows: [] });
    // 2nd call: INSERT → races + throws 23505
    pool.query.mockRejectedValueOnce(
      Object.assign(new Error("duplicate"), { code: "23505" }),
    );
    // 3rd call: post-race lookup → finds it
    pool.query.mockResolvedValueOnce({ rows: [existing] });

    const result = await attestation.upsertAttestation({
      on_chain_id: 7,
      source_chain: "polygon",
      source_tx_hash: "0xbeef",
      donor_address: stellarAddress("B"),
      project_id: "project-y",
      amount_usd: 5,
      amount_xlm: 40,
    });

    expect(result.created).toBe(false);
    expect(result.row).toEqual(existing);
    expect(pool.query.mock.calls.length).toBe(3);
  });

  test("inserts a fresh row and returns it", async () => {
    const inserted = {
      id: "new-uuid",
      on_chain_id: 12,
      source_chain: "ethereum",
      source_tx_hash: "0xcafe",
      donor_address: stellarAddress("C"),
      project_id: "project-z",
      amount_usd: "1.5",
      amount_xlm: "12.0",
      message_hash: 0,
      status: "pending",
      created_at: new Date().toISOString(),
      verified_at: null,
      recorded_by: null,
    };
    pool.query.mockResolvedValueOnce({ rows: [] }); // dedup
    pool.query.mockResolvedValueOnce({ rows: [inserted] }); // INSERT RETURNING

    const result = await attestation.upsertAttestation({
      on_chain_id: 12,
      source_chain: "ethereum",
      source_tx_hash: "0xcafe",
      donor_address: stellarAddress("C"),
      project_id: "project-z",
      amount_usd: 1.5,
      amount_xlm: 12,
    });

    expect(result.created).toBe(true);
    expect(result.row).toEqual(inserted);
    expect(pool.query.mock.calls.length).toBe(2);
  });

  test("rejects invalid on_chain_id", async () => {
    await expect(
      attestation.upsertAttestation({
        on_chain_id: -1,
        source_chain: "ethereum",
        source_tx_hash: "0xdead",
        donor_address: stellarAddress("A"),
        project_id: "p",
        amount_usd: 1,
        amount_xlm: 1,
      }),
    ).rejects.toThrow(/Invalid on_chain_id/);
  });
});

describe("markVerified + revoke", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test("markVerified returns the new row on first verification", async () => {
    const updated = {
      id: "uuid",
      status: "verified",
      verified_at: new Date().toISOString(),
    };
    pool.query.mockResolvedValueOnce({ rows: [updated] });
    const result = await attestation.markVerified("uuid");
    expect(result).toEqual(updated);
  });

  test("markVerified returns null when already verified", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await attestation.markVerified("uuid")).toBeNull();
  });

  test("revoke returns the new row", async () => {
    const updated = { id: "uuid", status: "revoked" };
    pool.query.mockResolvedValueOnce({ rows: [updated] });
    const result = await attestation.revoke("uuid", "admin");
    expect(result).toEqual(updated);
  });

  test("revoke returns null when already revoked", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    expect(await attestation.revoke("uuid", "admin")).toBeNull();
  });
});

describe("finders", () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test("findBySource issues a lowercase chain query", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "x" }] });
    const row = await attestation.findBySource("Ethereum", "0xdef");
    expect(row).toEqual({ id: "x" });
    const [sql, params] = pool.query.mock.calls[0];
    expect(sql).toMatch(/SELECT \* FROM attestations/);
    expect(params).toEqual(["ethereum", "0xdef"]);
  });

  test("findByOnChainId reflects the numeric id param", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await attestation.findByOnChainId(42);
    expect(pool.query.mock.calls[0][1]).toEqual([42]);
  });

  test("listByDonor clamps the limit to 200", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await attestation.listByDonor(stellarAddress("A"), { limit: 999999 });
    expect(pool.query.mock.calls[0][1]).toEqual([stellarAddress("A"), 200]);
  });

  test("listByDonor uses default limit of 50 when no arg provided", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });
    await attestation.listByDonor(stellarAddress("A"));
    expect(pool.query.mock.calls[0][1]).toEqual([stellarAddress("A"), 50]);
  });
});
