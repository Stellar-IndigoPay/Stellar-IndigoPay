/**
 * lib/pinning.ts
 *
 * Certificate / public-key pinning policy for the mobile networking layer.
 *
 * React Native's fetch/axios stack performs TLS validation natively (OkHttp on
 * Android, NSURLSession on iOS) and does NOT expose the verified certificate
 * chain to JavaScript. This module therefore owns the *pinning policy* — which
 * hosts are pinned, which pins are allowed, how pins rotate safely, and how a
 * remote pin-update is authenticated — so that:
 *
 *   1. The policy is a single, unit-testable source of truth.
 *   2. The native enforcement layer (Android Network Security Config
 *      `<pin-set>` / iOS TrustKit) is configured from the SAME pins, so the
 *      JS policy and the native TLS layer can never drift.
 *   3. `lib/apiClient.ts` can assert the policy before every request and can
 *      run a registered native `PinningVerifier` when one is available.
 *
 * A peer certificate is pinned by the base64 SHA-256 digest of its
 * DER-encoded SubjectPublicKeyInfo (SPKI), expressed in RFC 7469 form:
 * `sha256/<base64>`. Multiple pins per host are supported so a certificate
 * rotation can ship the next pin ahead of time (see `PinRegistry.rotatePins`).
 *
 * Dev builds get a pinning allowlist: localhost/loopback hosts and hosts with
 * no configured policy are never enforced, so a developer pointing the app at
 * `http://localhost:4000` is not blocked.
 */

// ─── Types ────────────────────────────────────────────────────────────────

export type PinAlgorithm = "sha256";

export interface Pin {
  /** Base64 SHA-256 digest of the DER-encoded SubjectPublicKeyInfo. */
  digest: string;
  algorithm: PinAlgorithm;
}

export interface HostPolicy {
  /** Normalized hostname this policy applies to (lowercase, no scheme/port). */
  host: string;
  /** Active pins — at least one must match the peer certificate. */
  pins: Pin[];
  /**
   * Pins from a previous rotation that are still accepted during the
   * transition window (see `graceUntil`). This is what makes rotation safe:
   * a freshly rotated certificate is accepted immediately while old clients
   * that still present the previous certificate are not locked out.
   */
  gracePins: Pin[];
  /**
   * Epoch ms until `gracePins` stop being accepted. `null` means the grace
   * window never expires (e.g. rotation not yet confirmed).
   */
  graceUntil: number | null;
  /** When true the host is exempt from pinning (explicit allowlist entry). */
  bypass: boolean;
}

/** Map of normalized hostname → pinning policy. */
export type PinningPolicy = Record<string, HostPolicy>;

export type PinErrorCode =
  | "PIN_MISMATCH"
  | "HOST_NOT_PINNED"
  | "INVALID_PIN_FORMAT"
  | "INVALID_SIGNATURE"
  | "STALE_PIN_UPDATE"
  | "PINNING_NOT_ENFORCED";

/** Structured failure thrown when pinning validation fails. */
export class PinningError extends Error {
  readonly code: PinErrorCode;
  readonly host: string;

  constructor(code: PinErrorCode, host: string, message: string) {
    super(`[${code}] ${message}`);
    this.name = "PinningError";
    this.code = code;
    this.host = host;
  }
}

// ─── Host / pin normalization ─────────────────────────────────────────────

const LOCALHOST_RE =
  /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0)$/;

/**
 * Reduce an arbitrary URL or host string to a bare hostname (lowercase, no
 * scheme, port, or path). `https://api.example.com:443/v1` → `api.example.com`.
 */
export function normalizeHost(input: string): string {
  let s = String(input).trim();
  // Strip scheme (https://, http://, etc.)
  const schemeIdx = s.indexOf("://");
  if (schemeIdx !== -1) s = s.slice(schemeIdx + 3);
  // Strip path / query / fragment
  const pathIdx = s.search(/[/?#]/);
  if (pathIdx !== -1) s = s.slice(0, pathIdx);
  // Strip port
  const portIdx = s.lastIndexOf(":");
  if (portIdx !== -1 && /^\d+$/.test(s.slice(portIdx + 1))) {
    s = s.slice(0, portIdx);
  }
  // Strip IPv6 brackets
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  return s.toLowerCase();
}

function isLocalhost(host: string): boolean {
  return LOCALHOST_RE.test(host);
}

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function base64Decode(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }
  // Manual fallback for environments without a global atob.
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const clean = b64.replace(/=+$/, "");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const val = alphabet.indexOf(clean[i]);
    if (val === -1) throw new Error("Invalid base64");
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Parse an RFC 7469-style pin (`sha256/<base64>`) or a bare base64 digest.
 * Throws `PinningError(INVALID_PIN_FORMAT)` when the value is malformed or
 * does not decode to a 32-byte SHA-256 digest.
 */
export function parsePin(value: string): Pin {
  const trimmed = String(value).trim();
  let digest = trimmed;
  let algorithm: PinAlgorithm = "sha256";
  if (trimmed.startsWith("sha256/")) {
    digest = trimmed.slice("sha256/".length);
  } else if (trimmed.includes("/")) {
    throw new PinningError(
      "INVALID_PIN_FORMAT",
      "",
      `Unsupported pin algorithm in "${trimmed}" (expected sha256/<base64>)`,
    );
  }
  if (!BASE64_RE.test(digest)) {
    throw new PinningError(
      "INVALID_PIN_FORMAT",
      "",
      `Pin "${trimmed}" is not valid base64`,
    );
  }
  let decoded: Uint8Array;
  try {
    decoded = base64Decode(digest);
  } catch {
    throw new PinningError(
      "INVALID_PIN_FORMAT",
      "",
      `Pin "${trimmed}" is not valid base64`,
    );
  }
  if (decoded.length !== 32) {
    throw new PinningError(
      "INVALID_PIN_FORMAT",
      "",
      `Pin "${trimmed}" must decode to 32 bytes (SHA-256), got ${decoded.length}`,
    );
  }
  return { digest, algorithm };
}

/** Serialize a pin back to RFC 7469 form (`sha256/<base64>`). */
export function pinToString(pin: Pin): string {
  return `${pin.algorithm}/${pin.digest}`;
}

/** Pin digest equality helper (normalizes `sha256/` prefixes). */
function sameDigest(a: string, b: string): boolean {
  return a.replace(/^sha256\//, "") === b.replace(/^sha256\//, "");
}

// ─── Policy construction ──────────────────────────────────────────────────

export interface CreateHostPolicyOptions {
  /** Pin values in RFC 7469 form (`sha256/<base64>`) or bare base64. */
  pins: string[];
  /** Previous pins kept during a rotation transition. */
  gracePins?: string[];
  graceUntil?: number | null;
  bypass?: boolean;
}

/** Build a normalized `HostPolicy` from string pin values. */
export function createHostPolicy(
  host: string,
  options: CreateHostPolicyOptions,
): HostPolicy {
  const normalized = normalizeHost(host);
  return {
    host: normalized,
    pins: options.pins.map(parsePin),
    gracePins: (options.gracePins ?? []).map(parsePin),
    graceUntil: options.graceUntil ?? null,
    bypass: options.bypass ?? false,
  };
}

/**
 * Build a `PinningPolicy` from environment variables (Expo inlines
 * `EXPO_PUBLIC_*` at build time). Supports:
 *
 *   EXPO_PUBLIC_PINNING_ENABLED  — "false" disables pinning entirely
 *   EXPO_PUBLIC_PINNING_POLICY  — JSON mapping host → pins, e.g.
 *     {"api.example.com":["sha256/AAA...","sha256/BBB..."]}
 *   EXPO_PUBLIC_PIN_UPDATE_SECRET — HMAC-SHA256 secret authenticating remote
 *     pin updates (see `applyRemotePinUpdate`).
 *
 * A malformed policy JSON degrades to an empty policy (nothing pinned) rather
 * than crashing the app at startup.
 */
export function parsePolicyFromEnv(
  env: Record<string, string | undefined>,
): PinningPolicy {
  const policy: PinningPolicy = {};
  // Master switch: `EXPO_PUBLIC_PINNING_ENABLED=false` pins nothing.
  if (String(env.EXPO_PUBLIC_PINNING_ENABLED).toLowerCase() === "false") {
    return policy;
  }
  const raw = env.EXPO_PUBLIC_PINNING_POLICY;
  if (!raw) return policy;
  try {
    const parsed = JSON.parse(raw) as Record<string, string[] | string>;
    for (const [host, pins] of Object.entries(parsed)) {
      const list = Array.isArray(pins) ? pins : String(pins).split(",");
      policy[normalizeHost(host)] = createHostPolicy(host, { pins: list });
    }
  } catch {
    // Malformed config → nothing pinned; operators are warned at build time.
  }
  return policy;
}

/** Load the default policy from `process.env` (used at module scope). */
export function loadDefaultPolicy(): PinningPolicy {
  return parsePolicyFromEnv(process.env as Record<string, string | undefined>);
}

// ─── Policy queries ───────────────────────────────────────────────────────

/** All pins currently accepted for a host (active + unexpired grace). */
export function getEffectivePins(
  policy: PinningPolicy,
  host: string,
  now: number = Date.now(),
): Pin[] {
  const h = normalizeHost(host);
  const hp = policy[h];
  if (!hp) return [];
  const grace =
    hp.graceUntil !== null && hp.graceUntil !== undefined && now <= hp.graceUntil
      ? hp.gracePins
      : [];
  return [...hp.pins, ...grace];
}

/** Whether the host has an active pinning policy (not bypassed). */
export function isHostPinned(policy: PinningPolicy, host: string): boolean {
  const hp = policy[normalizeHost(host)];
  return !!hp && !hp.bypass && hp.pins.length > 0;
}

export interface PinningBypassOptions {
  /** Whether this is a development build (defaults to `__DEV__`). */
  isDev?: boolean;
  /** Extra hostnames to always allow (dev allowlist). */
  allowlist?: string[];
}

/**
 * Whether pinning is (or should be) skipped for a host:
 *   - loopback / localhost hosts (nothing to pin over plaintext HTTP)
 *   - hosts in the explicit allowlist
 *   - hosts whose policy has `bypass: true`
 *   - any unconfigured host in a development build (dev allowlist)
 */
export function isPinningBypassed(
  policy: PinningPolicy,
  host: string,
  options: PinningBypassOptions = {},
): boolean {
  const h = normalizeHost(host);
  const isDev =
    options.isDev ?? (typeof __DEV__ !== "undefined" ? __DEV__ : false);
  if (isLocalhost(h)) return true;
  if (options.allowlist?.includes(h)) return true;
  const hp = policy[h];
  if (hp?.bypass) return true;
  if (isDev && !hp) return true;
  return false;
}

/** Boolean check: is `pin` accepted for `host`? */
export function isPinAllowed(
  policy: PinningPolicy,
  host: string,
  pin: Pin | string,
  now: number = Date.now(),
): boolean {
  const h = normalizeHost(host);
  const parsed = typeof pin === "string" ? parsePin(pin) : pin;
  return getEffectivePins(policy, h, now).some((p) =>
    sameDigest(p.digest, parsed.digest),
  );
}

/**
 * Validate a set of presented pins against the policy for `host`.
 *
 * Throws `PinningError` when the peer's pins do not match. This is the
 * enforcement primitive: a native `PinningVerifier` (or a test) calls it with
 * the certificate's SPKI pin(s) and a mismatch is rejected with
 * `PIN_MISMATCH`.
 *
 * Returns the matched pin on success.
 */
export function validatePins(
  policy: PinningPolicy,
  host: string,
  presentedPins: Array<Pin | string>,
  options: { now?: number } = {},
): Pin {
  const h = normalizeHost(host);
  if (!isHostPinned(policy, h)) {
    throw new PinningError(
      "HOST_NOT_PINNED",
      h,
      `Host "${h}" has no active pinning policy; refusing to validate pins.`,
    );
  }
  const now = options.now ?? Date.now();
  const effective = getEffectivePins(policy, h, now);
  const presented = presentedPins.map((p) =>
    typeof p === "string" ? parsePin(p) : p,
  );
  for (const candidate of effective) {
    if (presented.some((p) => sameDigest(p.digest, candidate.digest))) {
      return candidate;
    }
  }
  throw new PinningError(
    "PIN_MISMATCH",
    h,
    `Certificate pin mismatch for "${h}": none of the presented pins are in the pinned set.`,
  );
}

// ─── Pin registry & safe rotation ─────────────────────────────────────────

const DEFAULT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface RotatePinsOptions {
  /** Explicit grace deadline (overrides `graceMs`). */
  graceUntil?: number | null;
  /** How long previous pins remain accepted (default 7 days). */
  graceMs?: number;
  /** Clock override for deterministic tests. */
  now?: number;
}

/**
 * Mutable pinning policy store with a safe rotation mechanism.
 *
 * Rotation is safe because it is *additive-first*: `rotatePins` promotes the
 * new pins to active immediately while demoting the previous active pins to a
 * grace set that remains accepted until `graceUntil`. A client that still
 * presents the old certificate is therefore not locked out mid-rotation, and
 * `confirmRotation` drops the old pins once the new certificate is confirmed
 * to be working.
 */
export class PinRegistry {
  private policy: PinningPolicy;

  constructor(initial: PinningPolicy = {}) {
    this.policy = {};
    for (const [host, hp] of Object.entries(initial)) {
      this.policy[normalizeHost(host)] = { ...hp, host: normalizeHost(host) };
    }
  }

  getPolicy(): PinningPolicy {
    return this.policy;
  }

  getHostPolicy(host: string): HostPolicy | undefined {
    return this.policy[normalizeHost(host)];
  }

  setPolicy(policy: PinningPolicy): void {
    this.policy = {};
    for (const [host, hp] of Object.entries(policy)) {
      this.policy[normalizeHost(host)] = { ...hp, host: normalizeHost(host) };
    }
  }

  /** All pins currently accepted for a host (active + unexpired grace). */
  getEffectivePins(host: string, now: number = Date.now()): Pin[] {
    return getEffectivePins(this.policy, host, now);
  }

  /**
   * Rotate a host's active pins. Previous active pins are demoted to the
   * grace set and remain accepted until `graceUntil`.
   */
  rotatePins(host: string, newPins: string[], options: RotatePinsOptions = {}): HostPolicy {
    const h = normalizeHost(host);
    const now = options.now ?? Date.now();
    const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
    const graceUntil =
      options.graceUntil !== undefined
        ? options.graceUntil
        : graceMs > 0
          ? now + graceMs
          : null;

    const current = this.policy[h];
    const active = newPins.map(parsePin);
    const prevActive = current?.pins ?? [];
    const gracePins = prevActive.filter(
      (p) => !active.some((a) => sameDigest(a.digest, p.digest)),
    );

    this.policy[h] = {
      host: h,
      pins: active,
      gracePins,
      graceUntil,
      bypass: current?.bypass ?? false,
    };
    return this.policy[h];
  }

  /**
   * Drop the grace pins for a host once the new certificate is confirmed to
   * be in use. Idempotent.
   */
  confirmRotation(host: string): HostPolicy | undefined {
    const h = normalizeHost(host);
    const hp = this.policy[h];
    if (hp) {
      hp.gracePins = [];
      hp.graceUntil = null;
    }
    return hp;
  }

  /**
   * Remove expired grace pins. Call periodically (or rely on
   * `getEffectivePins` which already filters by `graceUntil`).
   */
  purgeExpiredGrace(now: number = Date.now()): void {
    for (const hp of Object.values(this.policy)) {
      if (
        hp.graceUntil !== null &&
        hp.graceUntil !== undefined &&
        now > hp.graceUntil
      ) {
        hp.gracePins = [];
        hp.graceUntil = null;
      }
    }
  }
}

// ─── Remote pin updates (managed pin-update path) ─────────────────────────

/**
 * A signed, versioned pin update that can be applied at runtime. The payload
 * is authenticated with an HMAC-SHA256 signature using a secret shared by the
 * backend operator, so a MITM or a compromised channel cannot inject pins.
 */
export interface RemotePinUpdate {
  /** Hostname the update applies to. */
  host: string;
  /** New active pins in RFC 7469 form (`sha256/<base64>`). */
  pins: string[];
  /** Epoch ms the update was issued (replay protection). */
  issuedAt: number;
  /** Monotonic version; higher wins. */
  version: number;
}

const MAX_UPDATE_AGE_MS = 24 * 60 * 60 * 1000; // 24h
const CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 min

/** Deterministic canonical serialization of a pin update (fixed key order). */
export function canonicalizePinUpdate(update: RemotePinUpdate): string {
  return JSON.stringify({
    host: update.host,
    pins: update.pins,
    issuedAt: update.issuedAt,
    version: update.version,
  });
}

/** Compute the HMAC-SHA256 signature of a pin update (hex). */
export function signPinUpdate(
  update: RemotePinUpdate,
  secret: string,
): string {
  return bytesToHex(
    hmacSha256(utf8Encode(secret), utf8Encode(canonicalizePinUpdate(update))),
  );
}

/** Constant-time hex comparison (avoids leaking the expected signature). */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Verify an HMAC-SHA256 signature over a pin update payload.
 * Returns true when the signature matches (constant-time comparison).
 */
export function verifyPinUpdateSignature(
  update: RemotePinUpdate,
  signature: string,
  secret: string,
): boolean {
  if (!secret) return false;
  const expected = signPinUpdate(update, secret);
  return timingSafeEqualHex(expected, String(signature).trim());
}

/**
 * Apply a signed remote pin update to a registry. Rejects:
 *   - updates with an invalid signature (`INVALID_SIGNATURE`)
 *   - updates that are too old or stamped in the future (`STALE_PIN_UPDATE`)
 *   - versions older than the currently applied version (`STALE_PIN_UPDATE`)
 *
 * On success the new pins are rotated in with a grace window, so a remote
 * update can never lock out clients that still hold the previous certificate.
 */
export function applyRemotePinUpdate(
  registry: PinRegistry,
  update: RemotePinUpdate,
  signature: string,
  secret: string,
  options: { now?: number; graceMs?: number } = {},
): HostPolicy {
  if (!verifyPinUpdateSignature(update, signature, secret)) {
    throw new PinningError(
      "INVALID_SIGNATURE",
      update.host,
      `Pin update for "${update.host}" failed signature verification.`,
    );
  }
  const now = options.now ?? Date.now();
  if (update.issuedAt > now + CLOCK_SKEW_MS || now - update.issuedAt > MAX_UPDATE_AGE_MS) {
    throw new PinningError(
      "STALE_PIN_UPDATE",
      update.host,
      `Pin update for "${update.host}" is outside the accepted time window.`,
    );
  }
  const current = registry.getHostPolicy(update.host);
  const appliedVersion = (current as (HostPolicy & { version?: number }) | undefined)
    ?.version;
  if (
    current &&
    appliedVersion !== undefined &&
    update.version < appliedVersion
  ) {
    throw new PinningError(
      "STALE_PIN_UPDATE",
      update.host,
      `Pin update for "${update.host}" (v${update.version}) is older than the applied version.`,
    );
  }
  const rotated = registry.rotatePins(update.host, update.pins, {
    now,
    graceMs: options.graceMs,
  });
  // Track the applied version on the host policy for replay protection.
  (rotated as HostPolicy & { version?: number }).version = update.version;
  return rotated;
}

// ─── Minimal SHA-256 / HMAC-SHA256 ────────────────────────────────────────
//
// React Native (Hermes) does not ship Node's `crypto` module, so the HMAC
// used to authenticate remote pin updates is implemented here in pure JS.
// It is validated against the NIST SHA-256 vectors and RFC 4231 HMAC-SHA256
// test vectors in `lib/__tests__/pinning.test.ts`.

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** SHA-256 over a byte array. Returns 32 bytes. */
export function sha256(message: Uint8Array): Uint8Array {
  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
    0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const l = message.length;
  const bitLenHi = Math.floor((l * 8) / 0x100000000);
  const bitLenLo = (l * 8) >>> 0;
  const paddedLength = (((l + 8) >> 6) << 6) + 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[l] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLength - 8, bitLenHi, false);
  dv.setUint32(paddedLength - 4, bitLenLo, false);

  for (let i = 0; i < paddedLength; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = dv.getUint32(i + t * 4, false);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let a = H[0], b = H[1], c = H[2], d = H[3];
    let e = H[4], f = H[5], g = H[6], h = H[7];
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outDv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outDv.setUint32(i * 4, H[i], false);
  return out;
}

/** HMAC-SHA256 (RFC 2104) over a byte array. Returns 32 bytes. */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256(k);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = (k[i] ?? 0) ^ 0x36;
    opad[i] = (k[i] ?? 0) ^ 0x5c;
  }
  const inner = new Uint8Array(blockSize + message.length);
  inner.set(ipad);
  inner.set(message, blockSize);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(blockSize + 32);
  outer.set(opad);
  outer.set(innerHash, blockSize);
  return sha256(outer);
}

/** UTF-8 encode a string (self-contained; avoids TextEncoder availability). */
export function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.codePointAt(i)!;
    if (code > 0xffff) i++; // consume the low surrogate
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(
        0xe0 | (code >> 12),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

/** Hex-encode a byte array. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

/** Hex-decode a string into a byte array. */
export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 === 1 ? `0${hex}` : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
