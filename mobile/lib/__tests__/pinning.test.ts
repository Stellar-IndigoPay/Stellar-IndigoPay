/**
 * lib/__tests__/pinning.test.ts
 *
 * Unit tests for `lib/pinning.ts` — the certificate/public-key pinning policy.
 *
 * Covers:
 *   - host / pin normalization and parsing
 *   - policy construction (including from env vars)
 *   - pin validation: match, mismatch rejection, unconfigured hosts
 *   - dev-build allowlist (localhost, explicit allowlist, bypass)
 *   - safe rotation (grace pins, confirm, expiry)
 *   - remote pin updates (HMAC-SHA256 signature, replay / staleness guards)
 *   - SHA-256 (NIST vectors) and HMAC-SHA256 (RFC 4231 vectors) correctness
 */
import {
  PinRegistry,
  PinningError,
  applyRemotePinUpdate,
  canonicalizePinUpdate,
  createHostPolicy,
  getEffectivePins,
  hexToBytes,
  hmacSha256,
  isHostPinned,
  isPinAllowed,
  isPinningBypassed,
  normalizeHost,
  parsePin,
  parsePolicyFromEnv,
  pinToString,
  sha256,
  signPinUpdate,
  utf8Encode,
  validatePins,
  verifyPinUpdateSignature,
  bytesToHex,
} from "../pinning";

// Valid 32-byte base64 digests (RFC 7469 style). These are arbitrary but
// well-formed SPKI-style digests used to exercise the policy logic.
const PIN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="; // 32 zero bytes
const PIN_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="; // 32 x 0x04
const PIN_C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC="; // 32 x 0x08

// ─── normalizeHost ────────────────────────────────────────────────────────

describe("normalizeHost", () => {
  test("strips scheme, port, path, query, and lowercases", () => {
    expect(normalizeHost("https://API.Example.com:443/v1/projects?x=1")).toBe(
      "api.example.com",
    );
  });

  test("accepts a bare hostname", () => {
    expect(normalizeHost("api.indigopay.org")).toBe("api.indigopay.org");
  });

  test("handles http URLs and trailing slashes", () => {
    expect(normalizeHost("http://localhost:4000/")).toBe("localhost");
    expect(normalizeHost("http://localhost:4000/api/health")).toBe("localhost");
  });

  test("normalizes IPv6 loopback brackets", () => {
    expect(normalizeHost("http://[::1]:4000")).toBe("::1");
  });
});

// ─── parsePin ─────────────────────────────────────────────────────────────

describe("parsePin", () => {
  test("accepts RFC 7469 sha256/<base64> form", () => {
    const pin = parsePin(`sha256/${PIN_A}`);
    expect(pin.algorithm).toBe("sha256");
    expect(pin.digest).toBe(PIN_A);
  });

  test("accepts bare base64 digest", () => {
    const pin = parsePin(PIN_B);
    expect(pin.digest).toBe(PIN_B);
  });

  test("rejects non-base64 values", () => {
    expect(() => parsePin("not base64!!!")).toThrow(PinningError);
    expect(() => parsePin("sha256/%%%%")).toThrow(/INVALID_PIN_FORMAT/);
  });

  test("rejects digests that do not decode to 32 bytes", () => {
    expect(() => parsePin("c2hvcnQ=")).toThrow(/32 bytes/);
  });

  test("rejects unsupported algorithm prefixes", () => {
    expect(() => parsePin(`md5/${PIN_A}`)).toThrow(/algorithm/);
  });

  test("pinToString round-trips RFC 7469 form", () => {
    const pin = parsePin(`sha256/${PIN_A}`);
    expect(pinToString(pin)).toBe(`sha256/${PIN_A}`);
  });
});

// ─── Policy construction ──────────────────────────────────────────────────

describe("createHostPolicy / parsePolicyFromEnv", () => {
  test("createHostPolicy normalizes the host and parses pins", () => {
    const hp = createHostPolicy("HTTPS://Api.Example.com", {
      pins: [`sha256/${PIN_A}`, PIN_B],
    });
    expect(hp.host).toBe("api.example.com");
    expect(hp.pins).toHaveLength(2);
    expect(hp.gracePins).toHaveLength(0);
    expect(hp.bypass).toBe(false);
  });

  test("parsePolicyFromEnv builds a policy from JSON", () => {
    const policy = parsePolicyFromEnv({
      EXPO_PUBLIC_PINNING_POLICY: JSON.stringify({
        "api.example.com": [`sha256/${PIN_A}`],
        "horizon.stellar.org": [`sha256/${PIN_B}`, `sha256/${PIN_C}`],
      }),
    });
    expect(policy["api.example.com"].pins).toHaveLength(1);
    expect(policy["horizon.stellar.org"].pins).toHaveLength(2);
  });

  test("parsePolicyFromEnv degrades to an empty policy on malformed JSON", () => {
    expect(parsePolicyFromEnv({ EXPO_PUBLIC_PINNING_POLICY: "{oops" })).toEqual(
      {},
    );
    expect(parsePolicyFromEnv({})).toEqual({});
  });

  test("parsePolicyFromEnv honors EXPO_PUBLIC_PINNING_ENABLED=false", () => {
    const env = {
      EXPO_PUBLIC_PINNING_ENABLED: "false",
      EXPO_PUBLIC_PINNING_POLICY: JSON.stringify({
        "api.example.com": [`sha256/${PIN_A}`],
      }),
    };
    expect(parsePolicyFromEnv(env)).toEqual({});
  });
});

// ─── Policy queries ───────────────────────────────────────────────────────

describe("policy queries", () => {
  const policy = {
    "api.example.com": createHostPolicy("api.example.com", {
      pins: [`sha256/${PIN_A}`],
    }),
  };

  test("isHostPinned is true only for configured, non-bypassed hosts", () => {
    expect(isHostPinned(policy, "api.example.com")).toBe(true);
    expect(isHostPinned(policy, "other.example.com")).toBe(false);
  });

  test("isHostPinned is false for a bypassed host", () => {
    const bypassed = {
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
        bypass: true,
      }),
    };
    expect(isHostPinned(bypassed, "api.example.com")).toBe(false);
  });

  test("isPinAllowed matches active pins", () => {
    expect(isPinAllowed(policy, "api.example.com", `sha256/${PIN_A}`)).toBe(
      true,
    );
    expect(isPinAllowed(policy, "api.example.com", `sha256/${PIN_B}`)).toBe(
      false,
    );
  });

  test("getEffectivePins includes unexpired grace pins only", () => {
    const registry = new PinRegistry(policy);
    registry.rotatePins("api.example.com", [`sha256/${PIN_B}`], {
      now: 1000,
      graceMs: 1000,
    });
    // Within the grace window both old and new pins are accepted.
    expect(
      getEffectivePins(registry.getPolicy(), "api.example.com", 1500).map((p) =>
        p.digest,
      ),
    ).toEqual(expect.arrayContaining([PIN_A, PIN_B]));
    // After the window the old pin is dropped.
    expect(
      getEffectivePins(registry.getPolicy(), "api.example.com", 2500).map((p) =>
        p.digest,
      ),
    ).toEqual([PIN_B]);
  });
});

// ─── validatePins / mismatch rejection ────────────────────────────────────

describe("validatePins", () => {
  const policy = {
    "api.example.com": createHostPolicy("api.example.com", {
      pins: [`sha256/${PIN_A}`],
    }),
  };

  test("accepts a matching presented pin", () => {
    const matched = validatePins(policy, "api.example.com", [
      `sha256/${PIN_A}`,
    ]);
    expect(matched.digest).toBe(PIN_A);
  });

  test("rejects a mismatched presented pin with PIN_MISMATCH", () => {
    try {
      validatePins(policy, "api.example.com", [`sha256/${PIN_B}`]);
      throw new Error("expected validatePins to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PinningError);
      expect((err as PinningError).code).toBe("PIN_MISMATCH");
      expect((err as PinningError).host).toBe("api.example.com");
    }
  });

  test("rejects when the host is not pinned with HOST_NOT_PINNED", () => {
    expect(() =>
      validatePins(policy, "unconfigured.example.com", [`sha256/${PIN_A}`]),
    ).toThrow(/HOST_NOT_PINNED/);
  });

  test("matches any pin when the peer presents multiple pins", () => {
    // Peer presented two pins, one of which is allowed.
    const matched = validatePins(policy, "api.example.com", [
      `sha256/${PIN_B}`,
      `sha256/${PIN_A}`,
    ]);
    expect(matched.digest).toBe(PIN_A);
  });
});

// ─── Dev allowlist / bypass ───────────────────────────────────────────────

describe("isPinningBypassed", () => {
  const policy = {
    "api.example.com": createHostPolicy("api.example.com", {
      pins: [`sha256/${PIN_A}`],
    }),
  };

  test("always bypasses localhost / loopback hosts", () => {
    expect(isPinningBypassed(policy, "http://localhost:4000", { isDev: false })).toBe(true);
    expect(isPinningBypassed(policy, "127.0.0.1", { isDev: false })).toBe(true);
  });

  test("bypasses hosts in the explicit allowlist", () => {
    expect(
      isPinningBypassed(policy, "api.example.com", {
        isDev: false,
        allowlist: ["api.example.com"],
      }),
    ).toBe(true);
  });

  test("bypasses hosts marked bypass:true", () => {
    const bypassed = {
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
        bypass: true,
      }),
    };
    expect(isPinningBypassed(bypassed, "api.example.com", { isDev: false })).toBe(
      true,
    );
  });

  test("bypasses unconfigured hosts in dev builds but not in production", () => {
    expect(isPinningBypassed(policy, "staging.example.com", { isDev: true })).toBe(
      true,
    );
    expect(
      isPinningBypassed(policy, "staging.example.com", { isDev: false }),
    ).toBe(false);
  });

  test("does NOT bypass a configured, non-allowlisted host in production", () => {
    expect(isPinningBypassed(policy, "api.example.com", { isDev: false })).toBe(
      false,
    );
  });
});

// ─── PinRegistry rotation ─────────────────────────────────────────────────

describe("PinRegistry rotation", () => {
  test("rotatePins promotes new pins and keeps old pins as grace", () => {
    const registry = new PinRegistry({
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
      }),
    });

    registry.rotatePins("api.example.com", [`sha256/${PIN_B}`], {
      now: 1000,
      graceMs: 5000,
    });

    const hp = registry.getHostPolicy("api.example.com")!;
    expect(hp.pins.map((p) => p.digest)).toEqual([PIN_B]);
    expect(hp.gracePins.map((p) => p.digest)).toEqual([PIN_A]);
    expect(hp.graceUntil).toBe(6000);

    // Both pins still validate during the grace window (fake clock).
    expect(
      validatePins(registry.getPolicy(), "api.example.com", [PIN_A], {
        now: 1500,
      }).digest,
    ).toBe(PIN_A);
    expect(
      validatePins(registry.getPolicy(), "api.example.com", [PIN_B], {
        now: 1500,
      }).digest,
    ).toBe(PIN_B);
  });

  test("confirmRotation drops grace pins", () => {
    const registry = new PinRegistry({
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
      }),
    });
    registry.rotatePins("api.example.com", [`sha256/${PIN_B}`], {
      now: 1000,
      graceMs: 5000,
    });
    registry.confirmRotation("api.example.com");

    const hp = registry.getHostPolicy("api.example.com")!;
    expect(hp.gracePins).toEqual([]);
    expect(hp.graceUntil).toBeNull();
    // Old pin is now rejected (fake clock, within the original window).
    expect(() =>
      validatePins(registry.getPolicy(), "api.example.com", [PIN_A], {
        now: 1500,
      }),
    ).toThrow(/PIN_MISMATCH/);
  });

  test("purgeExpiredGrace removes expired grace pins", () => {
    const registry = new PinRegistry({
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
      }),
    });
    registry.rotatePins("api.example.com", [`sha256/${PIN_B}`], {
      now: 1000,
      graceMs: 500,
    });
    registry.purgeExpiredGrace(2000);

    const hp = registry.getHostPolicy("api.example.com")!;
    expect(hp.gracePins).toEqual([]);
    expect(hp.graceUntil).toBeNull();
  });

  test("rotating to the same pin produces no grace duplicates", () => {
    const registry = new PinRegistry({
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
      }),
    });
    registry.rotatePins("api.example.com", [`sha256/${PIN_A}`, `sha256/${PIN_B}`], {
      now: 1000,
    });
    const hp = registry.getHostPolicy("api.example.com")!;
    expect(hp.pins).toHaveLength(2);
    expect(hp.gracePins).toEqual([]);
  });
});

// ─── SHA-256 / HMAC-SHA256 correctness ────────────────────────────────────

describe("sha256 (NIST vectors)", () => {
  const vectors: Array<[string, string]> = [
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    [
      "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    ],
  ];

  test.each(vectors)("sha256(%p) matches NIST vector", (input, expected) => {
    expect(bytesToHex(sha256(utf8Encode(input)))).toBe(expected);
  });

  test("processes multi-block messages (>= 64 bytes)", () => {
    const long = "a".repeat(1_000_000);
    // Known SHA-256 of 1,000,000 'a' characters.
    expect(bytesToHex(sha256(utf8Encode(long)))).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });
});

describe("hmacSha256 (RFC 4231 vectors)", () => {
  const vectors: Array<{ key: Uint8Array; data: Uint8Array; expected: string }> = [
    {
      key: new Uint8Array(20).fill(0x0b),
      data: utf8Encode("Hi There"),
      expected: "b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7",
    },
    {
      key: utf8Encode("Jefe"),
      data: utf8Encode("what do ya want for nothing?"),
      expected: "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    },
    {
      key: new Uint8Array(20).fill(0xaa),
      data: new Uint8Array(50).fill(0xdd),
      expected: "773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe",
    },
    {
      key: new Uint8Array(131).fill(0xaa),
      data: utf8Encode("Test Using Larger Than Block-Size Key - Hash Key First"),
      expected: "60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54",
    },
    {
      key: new Uint8Array(131).fill(0xaa),
      data: utf8Encode(
        "This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.",
      ),
      expected: "9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2",
    },
  ];

  test.each(vectors)(
    "HMAC-SHA256 matches RFC 4231 vector",
    ({ key, data, expected }) => {
      expect(bytesToHex(hmacSha256(key, data))).toBe(expected);
    },
  );

  test("hexToBytes round-trips", () => {
    expect(bytesToHex(hexToBytes("deadbeef"))).toBe("deadbeef");
  });
});

// ─── Remote pin updates ───────────────────────────────────────────────────

describe("remote pin updates", () => {
  const SECRET = "super-secret-pin-signing-key";
  const now = 1_700_000_000_000;

  function makeUpdate(overrides: Partial<Parameters<typeof canonicalizePinUpdate>[0]> = {}) {
    return {
      host: "api.example.com",
      pins: [`sha256/${PIN_B}`],
      issuedAt: now,
      version: 2,
      ...overrides,
    };
  }

  test("signPinUpdate / verifyPinUpdateSignature round-trip", () => {
    const update = makeUpdate();
    const signature = signPinUpdate(update, SECRET);
    expect(verifyPinUpdateSignature(update, signature, SECRET)).toBe(true);
    // Wrong secret fails.
    expect(verifyPinUpdateSignature(update, signature, "wrong")).toBe(false);
    // Tampered payload fails.
    expect(
      verifyPinUpdateSignature({ ...update, pins: [`sha256/${PIN_C}`] }, signature, SECRET),
    ).toBe(false);
  });

  test("rejects an update with an invalid signature", () => {
    const registry = new PinRegistry();
    expect(() =>
      applyRemotePinUpdate(registry, makeUpdate(), "deadbeef", SECRET, { now }),
    ).toThrow(/INVALID_SIGNATURE/);
  });

  test("applies a valid signed update with a grace window", () => {
    const registry = new PinRegistry({
      "api.example.com": createHostPolicy("api.example.com", {
        pins: [`sha256/${PIN_A}`],
      }),
    });
    const update = makeUpdate();
    const signature = signPinUpdate(update, SECRET);

    applyRemotePinUpdate(registry, update, signature, SECRET, { now, graceMs: 1000 });

    const hp = registry.getHostPolicy("api.example.com")!;
    expect(hp.pins.map((p) => p.digest)).toEqual([PIN_B]);
    expect(hp.gracePins.map((p) => p.digest)).toEqual([PIN_A]);
    // Both old and new still validate during the transition (fake clock).
    expect(
      validatePins(registry.getPolicy(), "api.example.com", [PIN_A], {
        now: now + 500,
      }),
    ).toBeTruthy();
    expect(
      validatePins(registry.getPolicy(), "api.example.com", [PIN_B], {
        now: now + 500,
      }),
    ).toBeTruthy();
  });

  test("rejects an update stamped in the future (clock skew)", () => {
    const registry = new PinRegistry();
    const update = makeUpdate({ issuedAt: now + 60 * 60 * 1000 }); // 1h ahead
    const signature = signPinUpdate(update, SECRET);
    expect(() =>
      applyRemotePinUpdate(registry, update, signature, SECRET, { now }),
    ).toThrow(/STALE_PIN_UPDATE/);
  });

  test("rejects an update older than the accepted window", () => {
    const registry = new PinRegistry();
    const update = makeUpdate({ issuedAt: now - 48 * 60 * 60 * 1000 }); // 48h old
    const signature = signPinUpdate(update, SECRET);
    expect(() =>
      applyRemotePinUpdate(registry, update, signature, SECRET, { now }),
    ).toThrow(/STALE_PIN_UPDATE/);
  });

  test("rejects an older version than already applied (replay guard)", () => {
    const registry = new PinRegistry();
    const v2 = makeUpdate({ version: 2 });
    applyRemotePinUpdate(registry, v2, signPinUpdate(v2, SECRET), SECRET, { now });

    const v1 = makeUpdate({ version: 1, pins: [`sha256/${PIN_C}`] });
    expect(() =>
      applyRemotePinUpdate(registry, v1, signPinUpdate(v1, SECRET), SECRET, { now }),
    ).toThrow(/STALE_PIN_UPDATE/);
  });
});
