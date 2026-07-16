/**
 * src/services/storage.js — Document storage abstraction
 *
 * Verification request forms accept supporting documents (PDFs, images,
 * spreadsheets). This service normalises upload handling so the same
 * `uploadFile()` contract works regardless of which backend is configured:
 *
 *   - "local"   (default)  → writes to backend/uploads/<key> and returns a
 *                            static URL served by GET /api/uploads/<key>.
 *                            No external credentials required.
 *   - "s3"     → uploads to a configured S3-compatible bucket using the
 *                AWS SDK; requires AWS_REGION, AWS_ACCESS_KEY_ID,
 *                AWS_SECRET_ACCESS_KEY, S3_BUCKET, optionally S3_PUBLIC_URL.
 *   - "ipfs"   → content-addressed decentralised storage. Two transports
 *                are supported, tried in order:
 *                  1. web3.storage HTTP API (WEB3_STORAGE_API_KEY) — POSTs
 *                     the raw bytes to https://api.web3.storage/upload.
 *                  2. IPFS node HTTP API (IPFS_API_URL) — POSTs a multipart
 *                     file to /api/v0/add (Infura, Pinata cluster, or a
 *                     local IPFS daemon).
 *                Returns the content identifier (CID); the gateway URL is
 *                derived from IPFS_GATEWAY_URL or https://w3s.link/ipfs/<cid>.
 *
 * In addition to the STORAGE_BACKEND dispatch, this module exposes:
 *   - uploadToIPFS(filePath, fileName)   Mirror an already-persisted local
 *     file to IPFS. Used by routes/verification.js to pin supporting
 *     documents at submission time. Never throws: when IPFS is not
 *     configured or the upload fails, it returns { cid: null } so the
 *     local copy remains the source of truth (IPFS_FALLBACK_TO_LOCAL).
 *   - verifyIPFSDocument(cid)   Re-download a document from the IPFS
 *     gateway and compute its SHA-256 so admins can check integrity
 *     against the fingerprint stored at submission time.
 *
 * The active backend is selected by STORAGE_BACKEND env var. If
 * STORAGE_BACKEND is "s3" or "ipfs" but the required credentials or
 * endpoint are missing, we fall back to local storage and log a warning
 * so uploads still succeed (a misconfigured production environment
 * shouldn't silently drop submissions). Set IPFS_FALLBACK_TO_LOCAL=false
 * to make IPFS upload failures hard errors instead.
 *
 * LIMITATIONS:
 *   - These are lightweight, dependency-free adapters. They deliberately
 *     avoid pulling in the full @aws-sdk/client-s3 package to keep the
 *     install footprint small. If you need presigned URLs, multipart
 *     uploads, or KMS encryption, replace the relevant branch with the
 *     official SDK.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const logger = require("../logger");

const STORAGE_BACKEND = process.env.STORAGE_BACKEND || "local";
const UPLOAD_DIR = path.join(__dirname, "..", "..", "uploads");

// Lazy-require AWS SDK so projects that don't use S3 don't need it.
function getAwsS3() {
  // The AWS SDK v3 ships modular packages, so use the bundled v2 client
  // (which is small and works without a build step) when present.
  try {
    // eslint-disable-next-line global-require
    return require("aws-sdk");
  } catch (err) {
    logger.warn(
      { event: "storage_s3_sdk_missing", err: err.message },
      "STORAGE_BACKEND=s3 but aws-sdk is not installed — falling back to local",
    );
    return null;
  }
}

function ensureUploadDir() {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

function buildKey(originalName) {
  const sanitized = String(originalName || "upload")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 80);
  const id = crypto.randomBytes(12).toString("hex");
  return `${id}-${sanitized}`;
}

async function uploadLocal(buffer, originalName, contentType) {
  ensureUploadDir();
  const key = buildKey(originalName);
  const fullPath = path.join(UPLOAD_DIR, key);
  await fs.promises.writeFile(fullPath, buffer);
  const url = `/api/uploads/${encodeURIComponent(key)}`;
  return {
    key,
    url,
    size: buffer.length,
    contentType: contentType || "application/octet-stream",
    backend: "local",
  };
}

async function uploadS3(buffer, originalName, contentType) {
  const AWS = getAwsS3();
  if (!AWS) return uploadLocal(buffer, originalName, contentType);

  const required = [
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "S3_BUCKET",
  ];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    logger.warn(
      { event: "storage_s3_env_missing", missing },
      "STORAGE_BACKEND=s3 but required env vars are missing — falling back to local",
    );
    return uploadLocal(buffer, originalName, contentType);
  }

  const s3 = new AWS.S3({
    region: process.env.AWS_REGION,
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  });
  const key = buildKey(originalName);
  await s3
    .putObject({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: contentType || "application/octet-stream",
      ACL: "public-read",
    })
    .promise();
  const publicUrl = process.env.S3_PUBLIC_URL
    ? `${process.env.S3_PUBLIC_URL.replace(/\/$/, "")}/${key}`
    : `https://${process.env.S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  return {
    key,
    url: publicUrl,
    size: buffer.length,
    contentType: contentType || "application/octet-stream",
    backend: "s3",
  };
}

async function uploadIpfs(buffer, originalName, contentType) {
  if (!isIpfsConfigured()) {
    logger.warn(
      { event: "storage_ipfs_env_missing" },
      "STORAGE_BACKEND=ipfs but neither WEB3_STORAGE_API_KEY nor IPFS_API_URL is set — falling back to local",
    );
    return uploadLocal(buffer, originalName, contentType);
  }

  try {
    const { cid, size } = await uploadBufferToIpfs(buffer, originalName);
    return {
      key: cid,
      cid,
      url: `${ipfsGatewayBase()}/${cid}`,
      size: size || buffer.length,
      sha256: sha256Hex(buffer),
      contentType: contentType || "application/octet-stream",
      backend: "ipfs",
    };
  } catch (err) {
    if (!ipfsFallbackToLocal()) throw err;
    logger.warn(
      { event: "storage_ipfs_upload_failed", err: err.message },
      "STORAGE_BACKEND=ipfs upload failed — falling back to local",
    );
    return uploadLocal(buffer, originalName, contentType);
  }
}

// ── IPFS helpers ─────────────────────────────────────────────────────────────

// How long we're willing to wait on the IPFS API / gateway before giving up.
function ipfsTimeoutMs() {
  return parseInt(process.env.IPFS_TIMEOUT_MS || "30000", 10);
}

// When true (default), a failed/unconfigured IPFS upload degrades to the
// local copy instead of failing the whole submission.
function ipfsFallbackToLocal() {
  return (
    String(process.env.IPFS_FALLBACK_TO_LOCAL || "true").toLowerCase() !==
    "false"
  );
}

// CIDv0 (Qm..., base58) and CIDv1 (base32/base36) are plain alphanumerics.
// Rejecting anything else keeps user input from injecting path segments
// into the gateway URL we fetch.
const CID_RE = /^[a-zA-Z0-9]{10,128}$/;

function isIpfsConfigured() {
  return Boolean(process.env.WEB3_STORAGE_API_KEY || process.env.IPFS_API_URL);
}

// Gateway base including the /ipfs path prefix. Operators may configure
// either https://w3s.link or https://w3s.link/ipfs; normalize both forms.
function ipfsGatewayBase() {
  const gateway = (process.env.IPFS_GATEWAY_URL || "https://w3s.link").replace(
    /\/$/,
    "",
  );
  return gateway.endsWith("/ipfs") ? gateway : `${gateway}/ipfs`;
}

function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Upload raw bytes to the web3.storage HTTP API. Kept dependency-free
 * (the official `web3.storage` npm client is deprecated and heavy) —
 * POST /upload with a Bearer token returns `{ cid }`.
 */
async function uploadViaWeb3Storage(buffer, fileName) {
  const base = (
    process.env.WEB3_STORAGE_API_URL || "https://api.web3.storage"
  ).replace(/\/$/, "");
  const res = await fetch(`${base}/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.WEB3_STORAGE_API_KEY}`,
      "X-NAME": encodeURIComponent(fileName || "upload"),
    },
    body: buffer,
    signal: AbortSignal.timeout(ipfsTimeoutMs()),
  });
  if (!res.ok) {
    throw new Error(
      `web3.storage upload failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = await res.json();
  if (!json || !json.cid) {
    throw new Error(
      "web3.storage upload succeeded but response did not include a CID",
    );
  }
  return { cid: json.cid, size: buffer.length };
}

/**
 * Upload a file to an IPFS node HTTP API (/api/v0/add). Works with a local
 * daemon, Infura, or a Pinata-compatible cluster endpoint.
 */
async function uploadViaNodeApi(buffer, fileName) {
  const apiUrl = process.env.IPFS_API_URL;

  const FormDataCtor = globalThis.FormData;
  const BlobCtor = globalThis.Blob;
  if (!FormDataCtor || !BlobCtor) {
    throw new Error(
      "IPFS adapter requires Node 18+ global FormData/Blob support",
    );
  }

  const form = new FormDataCtor();
  form.append("file", new BlobCtor([buffer]), fileName || "upload");

  const res = await fetch(
    `${apiUrl.replace(/\/$/, "")}/api/v0/add?wrap-with-directory=false`,
    {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(ipfsTimeoutMs()),
    },
  );
  if (!res.ok) {
    throw new Error(`IPFS upload failed: ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  // IPFS CLI HTTP API returns newline-delimited JSON.
  const last = text
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .pop();
  if (!last || !last.Hash) {
    throw new Error("IPFS upload succeeded but response did not include a CID");
  }
  return { cid: last.Hash, size: parseInt(last.Size, 10) || buffer.length };
}

/**
 * Upload a buffer to whichever IPFS transport is configured. web3.storage
 * takes precedence; an IPFS node HTTP API is the fallback. Throws when
 * neither transport is configured.
 */
async function uploadBufferToIpfs(buffer, fileName) {
  if (process.env.WEB3_STORAGE_API_KEY) {
    return uploadViaWeb3Storage(buffer, fileName);
  }
  if (process.env.IPFS_API_URL) {
    return uploadViaNodeApi(buffer, fileName);
  }
  throw new Error(
    "IPFS is not configured: set WEB3_STORAGE_API_KEY or IPFS_API_URL",
  );
}

/**
 * Mirror an already-persisted local file to IPFS. Used by
 * routes/verification.js to pin supporting documents at submission time.
 *
 * Never throws while IPFS_FALLBACK_TO_LOCAL (default true): when IPFS is
 * unconfigured or the upload fails, it resolves `{ cid: null,
 * storage_backend: "local" }` so the caller keeps the local copy as the
 * source of truth. The SHA-256 of the file content is returned so the
 * fingerprint captured at submission time can later be compared against
 * a fresh gateway download (see verifyIPFSDocument).
 *
 * @param {string} filePath - Absolute path of the locally stored file.
 * @param {string} fileName - Display name used for the IPFS pin.
 * @returns {Promise<{cid: string|null, url?: string, sha256?: string, size?: number, storage_backend: string}>}
 */
async function uploadToIPFS(filePath, fileName) {
  if (!isIpfsConfigured()) {
    logger.warn(
      { event: "ipfs_no_key" },
      "WEB3_STORAGE_API_KEY / IPFS_API_URL not set, falling back to local",
    );
    return { cid: null, storage_backend: "local" };
  }

  try {
    const buffer = await fs.promises.readFile(filePath);
    const sha256 = sha256Hex(buffer);
    const { cid, size } = await uploadBufferToIpfs(buffer, fileName);
    logger.info(
      { event: "ipfs_upload_ok", cid, fileName },
      "Supporting document pinned to IPFS",
    );
    return {
      cid,
      url: `${ipfsGatewayBase()}/${cid}`,
      sha256,
      size: size || buffer.length,
      storage_backend: "ipfs",
    };
  } catch (err) {
    if (!ipfsFallbackToLocal()) throw err;
    logger.warn(
      { event: "ipfs_upload_failed", err: err.message, fileName },
      "IPFS upload failed — keeping local copy",
    );
    return { cid: null, storage_backend: "local" };
  }
}

/**
 * Re-download a document from the IPFS gateway and compute its SHA-256 so
 * its integrity can be checked. IPFS URLs are content-addressed, so a
 * successful retrieval already proves the bytes match the CID; comparing
 * the SHA-256 against the fingerprint captured at submission time
 * additionally guards against a misbehaving gateway.
 *
 * @param {string} cid - Content identifier to verify.
 * @param {{fileName?: string, expectedSha256?: string}} [opts]
 * @returns {Promise<{valid: boolean, cid?: string, hash?: string, size?: number, matches?: boolean, error?: string}>}
 */
async function verifyIPFSDocument(cid, opts = {}) {
  if (!CID_RE.test(String(cid || ""))) {
    return { valid: false, error: "Invalid CID" };
  }

  let url = `${ipfsGatewayBase()}/${cid}`;
  if (opts.fileName) url += `/${encodeURIComponent(opts.fileName)}`;

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(ipfsTimeoutMs()),
    });
    if (!response.ok) {
      return {
        valid: false,
        error: `Document not retrievable (HTTP ${response.status})`,
      };
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const hash = sha256Hex(buffer);
    const result = { valid: true, cid, hash, size: buffer.length };
    if (opts.expectedSha256) {
      result.matches = hash === String(opts.expectedSha256).toLowerCase();
      result.valid = result.matches;
      if (!result.matches) {
        result.error = "Content hash does not match the recorded fingerprint";
      }
    }
    return result;
  } catch (err) {
    return { valid: false, error: `Gateway fetch failed: ${err.message}` };
  }
}

/**
 * Upload a file buffer with metadata, dispatching to the configured backend.
 *
 * @param {Buffer} buffer - File contents.
 * @param {string} originalName - Original filename (sanitised internally).
 * @param {string} contentType - MIME type from the upload.
 * @returns {Promise<{key:string,url:string,size:number,contentType:string,backend:string}>}
 */
async function uploadFile(buffer, originalName, contentType) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("uploadFile requires a Buffer");
  }
  const backend = (STORAGE_BACKEND || "local").toLowerCase();
  if (backend === "s3") return uploadS3(buffer, originalName, contentType);
  if (backend === "ipfs") return uploadIpfs(buffer, originalName, contentType);
  return uploadLocal(buffer, originalName, contentType);
}

function backendName() {
  return STORAGE_BACKEND;
}

module.exports = {
  uploadFile,
  backendName,
  uploadToIPFS,
  verifyIPFSDocument,
  isIpfsConfigured,
  UPLOAD_DIR,
};
