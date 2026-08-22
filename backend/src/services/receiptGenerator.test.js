"use strict";

jest.mock("./redis", () => ({
  get: jest.fn(),
  set: jest.fn(),
}));

const redis = require("./redis");
const {
  computeReceiptCacheKey,
  getOrGenerateReceiptPdf,
} = require("./receiptGenerator");

const DONATION_ID = "11111111-1111-1111-1111-111111111111";
const TX_HASH = "a".repeat(64);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("computeReceiptCacheKey", () => {
  it("is deterministic for the same donationId + transactionHash", () => {
    const a = computeReceiptCacheKey(DONATION_ID, TX_HASH);
    const b = computeReceiptCacheKey(DONATION_ID, TX_HASH);
    expect(a).toBe(b);
  });

  it("differs when the donationId differs", () => {
    const a = computeReceiptCacheKey(DONATION_ID, TX_HASH);
    const b = computeReceiptCacheKey("22222222-2222-2222-2222-222222222222", TX_HASH);
    expect(a).not.toBe(b);
  });

  it("differs when the transactionHash differs", () => {
    const a = computeReceiptCacheKey(DONATION_ID, TX_HASH);
    const b = computeReceiptCacheKey(DONATION_ID, "b".repeat(64));
    expect(a).not.toBe(b);
  });
});

describe("getOrGenerateReceiptPdf", () => {
  it("returns the Redis-cached PDF and never calls generate() on a cache hit", async () => {
    const cachedPdf = Buffer.from("cached pdf bytes");
    redis.get.mockResolvedValueOnce(cachedPdf.toString("base64"));

    const generate = jest.fn();
    const result = await getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);

    expect(result.source).toBe("redis");
    expect(result.pdf).toEqual(cachedPdf);
    expect(generate).not.toHaveBeenCalled();
  });

  it("calls generate() once on a cache miss and caches the result", async () => {
    redis.get.mockResolvedValueOnce(null);
    const freshPdf = Buffer.from("freshly generated pdf");
    const generate = jest.fn().mockResolvedValueOnce(freshPdf);

    const result = await getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);

    expect(result.source).toBe("generated");
    expect(result.pdf).toEqual(freshPdf);
    expect(generate).toHaveBeenCalledTimes(1);

    // Cache write happens fire-and-forget; give the microtask queue a turn.
    await Promise.resolve();
    expect(redis.set).toHaveBeenCalledWith(
      expect.any(String),
      freshPdf.toString("base64"),
      expect.any(Number),
    );
  });

  it("coalesces concurrent requests for the same content hash into a single generate() call", async () => {
    redis.get.mockResolvedValue(null); // every Redis check misses (cold cache)

    let resolveGenerate;
    const generate = jest.fn(
      () =>
        new Promise((resolve) => {
          resolveGenerate = resolve;
        }),
    );

    // Fire three concurrent requests for the SAME donation before the
    // first generate() call resolves.
    const p1 = getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);
    const p2 = getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);
    const p3 = getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);

    // Let the microtask queue advance so all three have reached the
    // in-flight-map check.
    await Promise.resolve();
    await Promise.resolve();

    const pdf = Buffer.from("the one true pdf");
    resolveGenerate(pdf);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(generate).toHaveBeenCalledTimes(1);
    expect(r1.pdf).toEqual(pdf);
    expect(r2.pdf).toEqual(pdf);
    expect(r3.pdf).toEqual(pdf);
    // The first caller triggered generation; the other two coalesced onto it.
    const sources = [r1.source, r2.source, r3.source].sort();
    expect(sources).toEqual(["coalesced", "coalesced", "generated"]);
  });

  it("allows a fresh generate() call after a previous generation completes", async () => {
    redis.get.mockResolvedValue(null);
    const firstPdf = Buffer.from("first");
    const secondPdf = Buffer.from("second");
    const generate = jest
      .fn()
      .mockResolvedValueOnce(firstPdf)
      .mockResolvedValueOnce(secondPdf);

    const first = await getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);
    expect(first.source).toBe("generated");

    // Second call: Redis still mocked as a miss (simulating cache write
    // having failed, or TTL expiry) — should call generate() again, not
    // reuse a stale in-flight entry from the completed first call.
    const second = await getOrGenerateReceiptPdf(DONATION_ID, TX_HASH, generate);
    expect(second.source).toBe("generated");
    expect(generate).toHaveBeenCalledTimes(2);
  });
});