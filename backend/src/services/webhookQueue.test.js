"use strict";

/**
 * Unit tests for webhookQueue.js mTLS integration.
 *
 * Covers: mTLS agent creation when a config is enabled, plain-HTTPS fallback
 * when no config exists, missing-config handling, and that the expiry metric
 * is published when mTLS is active.
 */

const crypto = require("crypto");
const https = require("https");

const pool = require("../db/pool");
const { metrics } = require("./metrics");
const { encryptPrivateKey } = require("./mtlsEncryption");

jest.mock("../db/pool", () => ({ query: jest.fn() }));
jest.mock("./mtlsEncryption", () => {
  const actual = jest.requireActual("./mtlsEncryption");
  return {
    ...actual,
    decryptPrivateKey: jest.fn((enc) => `decrypted:${enc}`),
  };
});

const {
  postSigned,
  getMTLSConfig,
  processDelivery,
} = require("./webhookQueue");

const TEST_KEY = crypto.randomBytes(32).toString("hex");

beforeAll(() => {
  process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = TEST_KEY;
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(metrics.mtlsCertExpirySeconds, "set").mockImplementation(() => {});
  jest.spyOn(metrics.webhookDeliveriesTotal, "inc").mockImplementation(() => {});
  jest.spyOn(metrics.webhookAttemptsTotal, "inc").mockImplementation(() => {});
});

describe("getMTLSConfig", () => {
  test("returns null when no config row exists", async () => {
    pool.query.mockResolvedValue({ rows: [] });
    const cfg = await getMTLSConfig("proj-1");
    expect(cfg).toBeNull();
  });

  test("returns the config row when present", async () => {
    const row = {
      enabled: true,
      ca_cert: "CA",
      client_cert: "CERT",
      client_key_encrypted: "ENC",
      client_key_iv: "IV",
      cert_expires_at: new Date(Date.now() + 86400000),
    };
    pool.query.mockResolvedValue({ rows: [row] });
    const cfg = await getMTLSConfig("proj-2");
    expect(cfg.enabled).toBe(true);
    expect(cfg.ca_cert).toBe("CA");
  });
});

describe("postSigned mTLS agent", () => {
  test("attaches the https.Agent for https urls when provided", async () => {
    const agent = new https.Agent();
    const spy = jest
      .spyOn(https, "request")
      .mockImplementation((options, cb) => {
        expect(options.agent).toBe(agent);
        const res = new (require("stream").Readable)({ read() {} });
        res.statusCode = 200;
        if (cb) cb(res);
        setImmediate(() => res.emit("end"));
        const req = new (require("events").EventEmitter)();
        req.write = () => {};
        req.end = () => {};
        req.destroy = () => {};
        return req;
      });
    const result = await postSigned(
      "https://partner.example.com/hook",
      "{}",
      {
        eventId: "e",
        eventType: "t",
        deliveryId: "d",
        timestamp: "1",
        signature: "s",
        attempt: 1,
      },
      agent,
    );
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    agent.destroy();
  });

  test("does not attach an agent for http urls", async () => {
    const http = require("http");
    const agent = new https.Agent();
    const spy = jest
      .spyOn(http, "request")
      .mockImplementation((options, cb) => {
        expect(options.agent).toBeUndefined();
        const res = new (require("stream").Readable)({ read() {} });
        res.statusCode = 200;
        if (cb) cb(res);
        setImmediate(() => res.emit("end"));
        const req = new (require("events").EventEmitter)();
        req.write = () => {};
        req.end = () => {};
        req.destroy = () => {};
        return req;
      });
    const result = await postSigned(
      "http://partner.example.com/hook",
      "{}",
      {
        eventId: "e",
        eventType: "t",
        deliveryId: "d",
        timestamp: "1",
        signature: "s",
        attempt: 1,
      },
      agent,
    );
    expect(result.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("processDelivery mTLS", () => {
  test("builds an https.Agent with cert/key when mTLS enabled and publishes expiry metric", async () => {
    const { clientCert, clientKey } = (() => {
      const kp = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
      return {
        clientCert: kp.publicKey.export({ type: "spki", format: "pem" }),
        clientKey: kp.privateKey.export({ type: "pkcs8", format: "pem" }),
      };
    })();
    const { encrypted, iv } = encryptPrivateKey(clientKey);
    const expiresAt = new Date(Date.now() + 10 * 86400000);

    // First query: delivery + project row.
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "d1",
            project_id: "p1",
            event_id: "e1",
            event_type: "milestone.reached",
            payload: { x: 1 },
            attempts: 0,
            webhook_url: "https://partner.example.com/hook",
            webhook_secret: "secret",
          },
        ],
      })
      // getMTLSConfig query.
      .mockResolvedValueOnce({
        rows: [
          {
            enabled: true,
            ca_cert: "CA",
            client_cert: clientCert,
            client_key_encrypted: encrypted,
            client_key_iv: iv,
            cert_expires_at: expiresAt,
          },
        ],
      })
      // UPDATE delivered (UPDATE webhook_deliveries ... status='delivered')
      .mockResolvedValueOnce({ rows: [] });

    // Resolve the HTTPS request with a stubbed socket to avoid real network.
    const requestSpy = jest
      .spyOn(https, "request")
      .mockImplementation((options, cb) => {
        expect(options.agent).toBeInstanceOf(https.Agent);
        expect(options.agent.options.cert).toBe(clientCert);
        expect(options.agent.options.key).toBe(`decrypted:${encrypted}`);
        expect(options.agent.options.ca).toBe("CA");
        expect(options.agent.options.rejectUnauthorized).toBe(true);
        const res = new (require("stream").Readable)({ read() {} });
        res.statusCode = 200;
        if (cb) cb(res);
        setImmediate(() => res.emit("end"));
        const req = new (require("events").EventEmitter)();
        req.write = () => {};
        req.end = () => {};
        req.destroy = () => {};
        return req;
      });

    await processDelivery("d1");

    expect(requestSpy).toHaveBeenCalled();
    expect(metrics.mtlsCertExpirySeconds.set).toHaveBeenCalledWith(
      { project_id: "p1" },
      expect.any(Number),
    );
    expect(metrics.webhookDeliveriesTotal.inc).toHaveBeenCalledWith({
      outcome: "delivered",
    });
    requestSpy.mockRestore();
  });

  test("falls back to plain HTTPS when no mTLS config exists", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "d2",
            project_id: "p2",
            event_id: "e2",
            event_type: "milestone.reached",
            payload: { x: 1 },
            attempts: 0,
            webhook_url: "https://partner.example.com/hook",
            webhook_secret: "secret",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // getMTLSConfig -> none
      .mockResolvedValueOnce({ rows: [] }); // UPDATE delivered

    const requestSpy = jest
      .spyOn(https, "request")
      .mockImplementation((options, cb) => {
        expect(options.agent).toBeUndefined();
        const res = new (require("stream").Readable)({ read() {} });
        res.statusCode = 200;
        if (cb) cb(res);
        setImmediate(() => res.emit("end"));
        const req = new (require("events").EventEmitter)();
        req.write = () => {};
        req.end = () => {};
        req.destroy = () => {};
        return req;
      });

    await processDelivery("d2");
    expect(requestSpy).toHaveBeenCalled();
    requestSpy.mockRestore();
  });

  test("marks delivery failed when mTLS agent build throws", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "d3",
            project_id: "p3",
            event_id: "e3",
            event_type: "milestone.reached",
            payload: { x: 1 },
            attempts: 0,
            webhook_url: "https://partner.example.com/hook",
            webhook_secret: "secret",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            enabled: true,
            ca_cert: null,
            client_cert: "CERT",
            client_key_encrypted: "ENC",
            client_key_iv: "IV",
            cert_expires_at: new Date(Date.now() + 86400000),
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }); // markTerminal

    const { decryptPrivateKey } = require("./mtlsEncryption");
    decryptPrivateKey.mockImplementationOnce(() => {
      throw new Error("bad key");
    });

    await processDelivery("d3");
    expect(pool.query).toHaveBeenLastCalledWith(
      expect.stringContaining("UPDATE webhook_deliveries"),
      expect.arrayContaining([expect.stringContaining("mtls config error")]),
    );
  });
});
