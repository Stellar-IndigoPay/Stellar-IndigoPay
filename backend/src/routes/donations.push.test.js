"use strict";

jest.mock("../db/pool", () => ({
  connect: jest.fn(),
}));

jest.mock("../middleware/rateLimiter", () => ({
  createRateLimiter: () => (req, res, next) => next(),
}));

jest.mock("../services/stellar", () => ({
  server: { getTransaction: jest.fn().mockResolvedValue({ successful: true }) },
}));

jest.mock("../services/profileQueue", () => ({
  enqueueProfileUpdate: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../services/pushQueue", () => ({
  enqueuePushNotification: jest.fn().mockResolvedValue(undefined),
}));

const pool = require("../db/pool");
const { enqueuePushNotification } = require("../services/pushQueue");
const { recordDonation } = require("./donations");

function makePublicKey(char = "A") {
  return `G${char.repeat(55)}`;
}

function makeTxHash(char = "a") {
  return char.repeat(64);
}

function queryResult(rows = []) {
  return { rows };
}

function createMockClient(...responses) {
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };

  responses.forEach((response) => {
    if (response instanceof Error) {
      client.query.mockRejectedValueOnce(response);
      return;
    }
    client.query.mockResolvedValueOnce(response);
  });

  pool.connect.mockResolvedValue(client);
  return client;
}

function createMockResponse() {
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

async function invokeRecordDonation(body) {
  const req = { body };
  const res = createMockResponse();
  const next = jest.fn((err) => {
    if (err) {
      res
        .status(err.status || 500)
        .json({ error: err.message || "Internal server error" });
    }
  });

  await recordDonation(req, res, next);
  return { req, res, next };
}

describe("POST /api/donations — push notification enqueue", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("enqueues a donation_receipt push job after recording a donation", async () => {
    const donorAddress = makePublicKey("A");
    const transactionHash = makeTxHash("a");
    const donationRow = {
      id: "donation-1",
      project_id: "project-1",
      donor_address: donorAddress,
      amount_xlm: "10",
      amount: "10",
      currency: "XLM",
      message: null,
      transaction_hash: transactionHash,
      created_at: "2026-03-29T10:00:00.000Z",
    };

    createMockClient(
      queryResult([{ id: "project-1" }]), // SELECT project
      queryResult([]), // dedup check
      queryResult(), // BEGIN
      queryResult([donationRow]), // INSERT donation
      queryResult([]), // SELECT donation_matches (empty)
      queryResult(), // UPDATE projects
      queryResult(), // COMMIT
    );

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "10",
      transactionHash,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(enqueuePushNotification).toHaveBeenCalledWith({
      type: "donation_receipt",
      payload: {
        donorAddress,
        projectId: "project-1",
        donationId: "donation-1",
        amount: 10,
        currency: "XLM",
      },
    });
  });

  test("a failed push enqueue is logged and does not fail the donation request", async () => {
    const donorAddress = makePublicKey("C");
    const transactionHash = makeTxHash("c");
    const donationRow = {
      id: "donation-2",
      project_id: "project-1",
      donor_address: donorAddress,
      amount_xlm: "5",
      amount: "5",
      currency: "XLM",
      message: null,
      transaction_hash: transactionHash,
      created_at: "2026-03-29T10:00:00.000Z",
    };

    createMockClient(
      queryResult([{ id: "project-1" }]),
      queryResult([]),
      queryResult(),
      queryResult([donationRow]),
      queryResult([]),
      queryResult(),
      queryResult(),
    );

    enqueuePushNotification.mockRejectedValueOnce(new Error("queue unavailable"));

    const { res, next } = await invokeRecordDonation({
      projectId: "project-1",
      donorAddress,
      amountXLM: "5",
      transactionHash,
    });

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
  });
});
