/**
 * storage.test.js — IPFS adapter unit tests
 *
 * Covers the GF-045 acceptance criteria:
 *   - documents uploaded to IPFS return a CID + gateway URL
 *   - fallback to local storage when no API key / endpoint is configured
 *   - fallback to local storage when the IPFS upload fails
 *   - integrity verification via SHA-256 against a mocked gateway
 *
 * `fetch` (Node 18+ global) is mocked so no network access happens.
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

jest.mock("../logger", () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const ENV_KEYS = [
  "STORAGE_BACKEND",
  "WEB3_STORAGE_API_KEY",
  "WEB3_STORAGE_API_URL",
  "IPFS_API_URL",
  "IPFS_GATEWAY_URL",
  "IPFS_FALLBACK_TO_LOCAL",
];

const FAKE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

describe("services/storage — IPFS", () => {
  let tmpFile;
  const originalEnv = {};
  const originalFetch = global.fetch;

  beforeAll(async () => {
    tmpFile = path.join(os.tmpdir(), `storage-test-${process.pid}.txt`);
    await fs.promises.writeFile(tmpFile, "verification document contents");
  });

  afterAll(async () => {
    await fs.promises.unlink(tmpFile).catch(() => {});
  });

  beforeEach(() => {
    jest.resetModules();
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    global.fetch = jest.fn();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    global.fetch = originalFetch;
  });

  function loadStorage() {
    // eslint-disable-next-line global-require
    return require("./storage");
  }

  describe("uploadToIPFS", () => {
    test("returns the CID and gateway URL when web3.storage succeeds", async () => {
      process.env.WEB3_STORAGE_API_KEY = "test-token";
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ cid: FAKE_CID }),
      });

      const { uploadToIPFS } = loadStorage();
      const result = await uploadToIPFS(tmpFile, "methodology.pdf");

      expect(result.cid).toBe(FAKE_CID);
      expect(result.url).toBe(`https://w3s.link/ipfs/${FAKE_CID}`);
      expect(result.storage_backend).toBe("ipfs");
      // SHA-256 fingerprint of the file is recorded for later verification.
      const expectedHash = crypto
        .createHash("sha256")
        .update("verification document contents")
        .digest("hex");
      expect(result.sha256).toBe(expectedHash);

      // Bearer token flows through to the web3.storage API call.
      const [url, opts] = global.fetch.mock.calls[0];
      expect(url).toBe("https://api.web3.storage/upload");
      expect(opts.headers.Authorization).toBe("Bearer test-token");
    });

    test("respects IPFS_GATEWAY_URL when building the document URL", async () => {
      process.env.WEB3_STORAGE_API_KEY = "test-token";
      process.env.IPFS_GATEWAY_URL = "https://example-gateway.test";
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ cid: FAKE_CID }),
      });

      const { uploadToIPFS } = loadStorage();
      const result = await uploadToIPFS(tmpFile, "doc.pdf");
      expect(result.url).toBe(`https://example-gateway.test/ipfs/${FAKE_CID}`);
    });

    test("uses the IPFS node HTTP API when only IPFS_API_URL is set", async () => {
      process.env.IPFS_API_URL = "http://127.0.0.1:5001";
      global.fetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ Name: "doc.pdf", Hash: FAKE_CID, Size: "31" }),
      });

      const { uploadToIPFS } = loadStorage();
      const result = await uploadToIPFS(tmpFile, "doc.pdf");

      expect(result.cid).toBe(FAKE_CID);
      expect(result.storage_backend).toBe("ipfs");
      const [url] = global.fetch.mock.calls[0];
      expect(url).toBe(
        "http://127.0.0.1:5001/api/v0/add?wrap-with-directory=false",
      );
    });

    test("falls back to local when no API key or endpoint is configured", async () => {
      const { uploadToIPFS } = loadStorage();
      const result = await uploadToIPFS(tmpFile, "doc.pdf");

      expect(result.cid).toBeNull();
      expect(result.storage_backend).toBe("local");
      expect(global.fetch).not.toHaveBeenCalled();
    });

    test("falls back to local when the IPFS upload fails", async () => {
      process.env.WEB3_STORAGE_API_KEY = "test-token";
      global.fetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: async () => "bad gateway",
      });

      const { uploadToIPFS } = loadStorage();
      const result = await uploadToIPFS(tmpFile, "doc.pdf");

      expect(result.cid).toBeNull();
      expect(result.storage_backend).toBe("local");
    });

    test("propagates upload errors when IPFS_FALLBACK_TO_LOCAL=false", async () => {
      process.env.WEB3_STORAGE_API_KEY = "test-token";
      process.env.IPFS_FALLBACK_TO_LOCAL = "false";
      global.fetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      });

      const { uploadToIPFS } = loadStorage();
      await expect(uploadToIPFS(tmpFile, "doc.pdf")).rejects.toThrow(
        /web3.storage upload failed/,
      );
    });
  });

  describe("verifyIPFSDocument", () => {
    const CONTENT = Buffer.from("verification document contents");
    const CONTENT_SHA256 = crypto
      .createHash("sha256")
      .update(CONTENT)
      .digest("hex");

    test("retrieves the document and returns its SHA-256", async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          CONTENT.buffer.slice(
            CONTENT.byteOffset,
            CONTENT.byteOffset + CONTENT.byteLength,
          ),
      });

      const { verifyIPFSDocument } = loadStorage();
      const result = await verifyIPFSDocument(FAKE_CID);

      expect(result.valid).toBe(true);
      expect(result.hash).toBe(CONTENT_SHA256);
      expect(result.size).toBe(CONTENT.length);
      const [url] = global.fetch.mock.calls[0];
      expect(url).toBe(`https://w3s.link/ipfs/${FAKE_CID}`);
    });

    test("reports matches=true when the expected SHA-256 matches", async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          CONTENT.buffer.slice(
            CONTENT.byteOffset,
            CONTENT.byteOffset + CONTENT.byteLength,
          ),
      });

      const { verifyIPFSDocument } = loadStorage();
      const result = await verifyIPFSDocument(FAKE_CID, {
        expectedSha256: CONTENT_SHA256,
      });
      expect(result.valid).toBe(true);
      expect(result.matches).toBe(true);
    });

    test("flags tampering when the retrieved hash does not match", async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          CONTENT.buffer.slice(
            CONTENT.byteOffset,
            CONTENT.byteOffset + CONTENT.byteLength,
          ),
      });

      const { verifyIPFSDocument } = loadStorage();
      const result = await verifyIPFSDocument(FAKE_CID, {
        expectedSha256: "a".repeat(64),
      });
      expect(result.valid).toBe(false);
      expect(result.matches).toBe(false);
      expect(result.error).toMatch(/does not match/);
    });

    test("returns valid=false when the gateway responds with an error", async () => {
      global.fetch.mockResolvedValue({ ok: false, status: 404 });

      const { verifyIPFSDocument } = loadStorage();
      const result = await verifyIPFSDocument(FAKE_CID);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/not retrievable/);
    });

    test("returns valid=false when the gateway is unreachable", async () => {
      global.fetch.mockRejectedValue(new Error("ECONNREFUSED"));

      const { verifyIPFSDocument } = loadStorage();
      const result = await verifyIPFSDocument(FAKE_CID);
      expect(result.valid).toBe(false);
      expect(result.error).toMatch(/Gateway fetch failed/);
    });

    test("rejects malformed CIDs without touching the network", async () => {
      const { verifyIPFSDocument } = loadStorage();
      const result = await verifyIPFSDocument("../../../etc/passwd");
      expect(result.valid).toBe(false);
      expect(result.error).toBe("Invalid CID");
      expect(global.fetch).not.toHaveBeenCalled();
    });
  });

  describe("uploadFile (STORAGE_BACKEND=ipfs)", () => {
    test("returns cid + ipfs backend when configured", async () => {
      process.env.STORAGE_BACKEND = "ipfs";
      process.env.WEB3_STORAGE_API_KEY = "test-token";
      global.fetch.mockResolvedValue({
        ok: true,
        json: async () => ({ cid: FAKE_CID }),
      });

      const { uploadFile } = loadStorage();
      const result = await uploadFile(
        Buffer.from("hello"),
        "doc.pdf",
        "application/pdf",
      );
      expect(result.backend).toBe("ipfs");
      expect(result.cid).toBe(FAKE_CID);
      expect(result.url).toBe(`https://w3s.link/ipfs/${FAKE_CID}`);
    });

    test("falls back to local when IPFS is unconfigured", async () => {
      process.env.STORAGE_BACKEND = "ipfs";

      const { uploadFile } = loadStorage();
      const result = await uploadFile(
        Buffer.from("hello"),
        "doc.pdf",
        "application/pdf",
      );
      expect(result.backend).toBe("local");
      expect(result.url).toMatch(/^\/api\/uploads\//);
      // Clean up the file the local fallback wrote.
      const { UPLOAD_DIR } = loadStorage();
      await fs.promises
        .unlink(path.join(UPLOAD_DIR, result.key))
        .catch(() => {});
    });

    test("falls back to local when a configured IPFS upload fails", async () => {
      process.env.STORAGE_BACKEND = "ipfs";
      process.env.WEB3_STORAGE_API_KEY = "test-token";
      global.fetch.mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => "unavailable",
      });

      const { uploadFile, UPLOAD_DIR } = loadStorage();
      const result = await uploadFile(
        Buffer.from("hello"),
        "doc.pdf",
        "application/pdf",
      );

      expect(result.backend).toBe("local");
      expect(result.url).toMatch(/^\/api\/uploads\//);
      await fs.promises
        .unlink(path.join(UPLOAD_DIR, result.key))
        .catch(() => {});
    });
  });
});
