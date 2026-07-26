"use strict";

/**
 * Integration tests for mTLS webhook delivery against a real local HTTPS
 * server that requires client certificates. Verifies the full handshake:
 * the server validates our client cert against its CA, and we validate the
 * server cert against the CA we send. Also covers rejection paths.
 */

const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const { encryptPrivateKey } = require("./mtlsEncryption");

// Generate a CA and an end-entity cert signed by it using openssl (Node has
// no built-in X.509 *creation* API). The client cert is signed by the CA so
// the mTLS server can verify it and the client can verify the server.
function buildCaAndCert(commonName) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mtls-int-"));

  // CA
  const caKey = path.join(tmp, "ca-key.pem");
  const caCsr = path.join(tmp, "ca-csr.pem");
  const caCert = path.join(tmp, "ca-cert.pem");
  const caExt = path.join(tmp, "ca-ext.cnf");
  fs.writeFileSync(
    caExt,
    "basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign\n",
  );
  execFileSync("openssl", ["genrsa", "-traditional", "-out", caKey, "2048"]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-key",
    caKey,
    "-subj",
    "/CN=Integration Test CA",
    "-out",
    caCsr,
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    caCsr,
    "-signkey",
    caKey,
    "-days",
    "365",
    "-extfile",
    caExt,
    "-out",
    caCert,
  ]);

  // End-entity (client) cert signed by the CA.
  const eeKey = path.join(tmp, "ee-key.pem");
  const eeCsr = path.join(tmp, "ee-csr.pem");
  const eeCert = path.join(tmp, "ee-cert.pem");
  execFileSync("openssl", ["genrsa", "-traditional", "-out", eeKey, "2048"]);
  execFileSync("openssl", [
    "req",
    "-new",
    "-key",
    eeKey,
    "-subj",
    `/CN=${commonName}`,
    "-out",
    eeCsr,
  ]);
  execFileSync("openssl", [
    "x509",
    "-req",
    "-in",
    eeCsr,
    "-CA",
    caCert,
    "-CAkey",
    caKey,
    "-CAcreateserial",
    "-days",
    "365",
    "-out",
    eeCert,
  ]);

  const result = {
    caPem: fs.readFileSync(caCert, "utf8"),
    clientCert: fs.readFileSync(eeCert, "utf8"),
    clientKey: fs.readFileSync(eeKey, "utf8"),
  };
  fs.rmSync(tmp, { recursive: true, force: true });
  return result;
}

const { postSigned, processDelivery } = require("./webhookQueue");

const pool = require("../db/pool");
jest.mock("../db/pool", () => ({ query: jest.fn() }));

process.env.WEBHOOK_MTLS_ENCRYPTION_KEY = crypto.randomBytes(32).toString("hex");

describe("mTLS delivery integration (real TLS handshake)", () => {
  let server;
  let serverPort;
  let material;
  let received; // captured request info on the server

  beforeAll((done) => {
    material = buildCaAndCert("localhost");

    server = https.createServer(
      {
        key: material.clientKey,
        cert: material.clientCert,
        ca: material.caPem,
        requestCert: true, // require a client cert
        rejectUnauthorized: true, // reject clients not signed by our CA
      },
      (req, res) => {
        received = {
          clientVerified: req.client.authorized,
          clientCert: req.socket.getPeerCertificate(),
        };
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      },
    );

    server.listen(0, () => {
      serverPort = server.address().port;
      done();
    });
  });

  afterAll((done) => {
    server.close(() => done());
  });

  beforeEach(() => {
    jest.clearAllMocks();
    received = null;
    jest.spyOn(require("./metrics").metrics.mtlsCertExpirySeconds, "set").mockImplementation(() => {});
  });

  test("delivers over mTLS when the server validates our client cert", async () => {
    const { encrypted, iv } = encryptPrivateKey(material.clientKey);
    const expiresAt = new Date(Date.now() + 30 * 86400000);

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "int-1",
            project_id: "proj-int",
            event_id: "e-int",
            event_type: "milestone.reached",
            payload: { x: 1 },
            attempts: 0,
            webhook_url: `https://localhost:${serverPort}/hook`,
            webhook_secret: "secret",
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            enabled: true,
            ca_cert: material.caPem,
            client_cert: material.clientCert,
            client_key_encrypted: encrypted,
            client_key_iv: iv,
            cert_expires_at: expiresAt,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    await processDelivery("int-1");
    expect(received).not.toBeNull();
    expect(received.clientVerified).toBe(true);
  });

  test("delivery fails when no mTLS config exists but server requires a client cert", async () => {
    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: "int-2",
            project_id: "proj-int2",
            event_id: "e-int2",
            event_type: "milestone.reached",
            payload: { x: 1 },
            attempts: 0,
            webhook_url: `https://localhost:${serverPort}/hook`,
            webhook_secret: "secret",
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] }) // no mTLS config
      .mockResolvedValueOnce({ rows: [] }); // UPDATE delivered (will mark failed/retry)

    const m = require("./metrics");
    const incSpy = jest.spyOn(m.metrics.webhookDeliveriesTotal, "inc");

    // processDelivery will attempt a plain HTTPS request; the server requires a
    // client cert, so the TLS handshake is rejected -> error captured.
    const { postSigned } = require("./webhookQueue");
    const result = await postSigned(
      `https://localhost:${serverPort}/hook`,
      "{}",
      {
        eventId: "e",
        eventType: "t",
        deliveryId: "d",
        timestamp: "1",
        signature: "s",
        attempt: 1,
      },
    );
    expect(result.ok).toBe(false);
    incSpy.mockRestore();
  });

  test("postSigned attaches the agent for https URLs during a real handshake", async () => {
    const agent = new https.Agent({
      cert: material.clientCert,
      key: material.clientKey,
      ca: material.caPem,
      rejectUnauthorized: true,
    });
    const result = await postSigned(
      `https://localhost:${serverPort}/hook`,
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
    expect(received.clientVerified).toBe(true);
    agent.destroy();
  });
});
