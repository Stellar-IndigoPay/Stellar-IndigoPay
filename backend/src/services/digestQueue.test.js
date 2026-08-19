"use strict";

jest.mock("../db/pool", () => ({
  query: jest.fn(),
}));
jest.mock("./digestBuilder", () => ({
  buildDigests: jest.fn(),
}));
jest.mock("./email", () => ({
  sendDigestEmail: jest.fn(),
}));

const pool = require("../db/pool");
const { buildDigests } = require("./digestBuilder");
const { sendDigestEmail } = require("./email");
const {
  runDigest,
  claimDigestSend,
  markDigestSent,
  markDigestFailed,
} = require("./digestQueue");

const PERIOD_START = "2026-08-01T00:00:00.000Z";

function digestFixture(overrides = {}) {
  return {
    donorAddress: "GDONOR1",
    email: "donor1@example.com",
    totalDonatedXLM: 10,
    donationCount: 1,
    projectsSupported: 1,
    co2OffsetKg: 1,
    projectNames: ["Reforest Now"],
    recentDonations: [],
    unsubscribeToken: "tok",
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("claimDigestSend", () => {
  it("claims a fresh recipient+period via INSERT ... ON CONFLICT", async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ id: "row-1", attempts: 1 }] });

    const result = await claimDigestSend({
      type: "daily",
      donorAddress: "GDONOR1",
      periodStart: PERIOD_START,
    });

    expect(result).toEqual({ claimed: true, id: "row-1", attempts: 1 });
    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain("ON CONFLICT");
    expect(pool.query.mock.calls[0][1]).toEqual([
      "daily",
      "GDONOR1",
      PERIOD_START,
    ]);
  });

  it("does not claim when the recipient+period was already sent", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // insert conflicts
    pool.query.mockResolvedValueOnce({ rows: [] }); // retry finds no eligible row ('sent' doesn't match)

    const result = await claimDigestSend({
      type: "daily",
      donorAddress: "GDONOR1",
      periodStart: PERIOD_START,
    });

    expect(result).toEqual({ claimed: false });
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("re-claims a recipient+period whose previous attempt failed, under the retry cap", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] }); // insert conflicts
    pool.query.mockResolvedValueOnce({ rows: [{ id: "row-1", attempts: 2 }] }); // retry succeeds

    const result = await claimDigestSend({
      type: "daily",
      donorAddress: "GDONOR1",
      periodStart: PERIOD_START,
    });

    expect(result).toEqual({ claimed: true, id: "row-1", attempts: 2 });
  });

  it("does not re-claim once the retry cap is exhausted", async () => {
    // Both queries resolve empty — modelling a 'failed' row whose attempts
    // already equal MAX_SEND_ATTEMPTS, so the retry UPDATE's WHERE clause
    // excludes it.
    pool.query.mockResolvedValueOnce({ rows: [] });
    pool.query.mockResolvedValueOnce({ rows: [] });

    const result = await claimDigestSend({
      type: "daily",
      donorAddress: "GDONOR1",
      periodStart: PERIOD_START,
    });

    expect(result).toEqual({ claimed: false });
  });
});

describe("markDigestSent / markDigestFailed", () => {
  it("marks a claimed row as sent", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await markDigestSent("row-1");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'sent'"),
      ["row-1"],
    );
  });

  it("marks a claimed row as failed with the error message", async () => {
    pool.query.mockResolvedValueOnce({ rows: [] });

    await markDigestFailed("row-1", "Resend API down");

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'failed'"),
      ["row-1", "Resend API down"],
    );
  });
});

describe("runDigest", () => {
  it("sends to a freshly claimed recipient and skips one already sent", async () => {
    buildDigests.mockResolvedValueOnce({
      type: "daily",
      label: "Daily Digest — August 2026",
      periodStart: PERIOD_START,
      periodEnd: "2026-08-02T00:00:00.000Z",
      digests: [
        digestFixture({ donorAddress: "GDONOR1", email: "d1@example.com" }),
        digestFixture({ donorAddress: "GDONOR2", email: "d2@example.com" }),
      ],
    });

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "row-1", attempts: 1 }] }) // GDONOR1 claim: fresh
      .mockResolvedValueOnce({ rows: [] }) // GDONOR1 markDigestSent
      .mockResolvedValueOnce({ rows: [] }) // GDONOR2 claim insert: conflict
      .mockResolvedValueOnce({ rows: [] }); // GDONOR2 retry: no eligible row (already sent)

    sendDigestEmail.mockResolvedValueOnce({ id: "resend-1" });

    await runDigest("daily");

    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
    expect(sendDigestEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: "d1@example.com" }),
    );
  });

  it("does not send twice to the same recipient across two runDigest calls for the same period", async () => {
    const oneDigest = () => ({
      type: "daily",
      label: "Daily Digest — August 2026",
      periodStart: PERIOD_START,
      periodEnd: "2026-08-02T00:00:00.000Z",
      digests: [digestFixture({ donorAddress: "GDONOR1", email: "d1@example.com" })],
    });

    // First run: claim succeeds, send succeeds.
    buildDigests.mockResolvedValueOnce(oneDigest());
    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "row-1", attempts: 1 }] }) // claim
      .mockResolvedValueOnce({ rows: [] }); // markDigestSent
    sendDigestEmail.mockResolvedValueOnce({ id: "resend-1" });

    await runDigest("daily");
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);

    // Second run for the same period (e.g. a retried/duplicated job):
    // buildDigests still returns GDONOR1 (they qualified for the period),
    // but the claim is now already 'sent', so it must be skipped.
    buildDigests.mockResolvedValueOnce(oneDigest());
    pool.query
      .mockResolvedValueOnce({ rows: [] }) // claim insert: conflict (row exists, status 'sent')
      .mockResolvedValueOnce({ rows: [] }); // retry: 'sent' doesn't match the WHERE clause

    await runDigest("daily");

    // Still only ever called once in total across both runs.
    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
  });

  it("marks the claim as failed (not sent) when sendDigestEmail throws, without stopping the run", async () => {
    buildDigests.mockResolvedValueOnce({
      type: "daily",
      label: "Daily Digest — August 2026",
      periodStart: PERIOD_START,
      periodEnd: "2026-08-02T00:00:00.000Z",
      digests: [digestFixture({ donorAddress: "GDONOR1", email: "d1@example.com" })],
    });

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: "row-1", attempts: 1 }] }) // claim
      .mockResolvedValueOnce({ rows: [] }); // markDigestFailed

    sendDigestEmail.mockRejectedValueOnce(new Error("Resend API down"));

    await expect(runDigest("daily")).resolves.toBeUndefined();

    expect(sendDigestEmail).toHaveBeenCalledTimes(1);
    const failedCall = pool.query.mock.calls.find(([text]) =>
      text.includes("SET status = 'failed'"),
    );
    expect(failedCall).toBeTruthy();
    expect(failedCall[1]).toEqual(["row-1", "Resend API down"]);
  });
});