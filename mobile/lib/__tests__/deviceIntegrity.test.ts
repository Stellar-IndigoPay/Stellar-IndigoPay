/**
 * lib/__tests__/deviceIntegrity.test.ts
 *
 * Unit tests for `lib/deviceIntegrity.ts` covering:
 *   - policy resolution (env override + sanitisation, default "block")
 *   - pure policy mapping (clean/compromised × off/warn/block)
 *   - `enforceIntegrityPolicy` end-to-end with an injected (mocked) detector
 *   - the production expo-device detector (clean / rooted / throws)
 *   - warning surfacing (getLastIntegrityWarning + onIntegrityWarning)
 */
import * as Device from "expo-device";

import {
  checkDeviceIntegrity,
  DEFAULT_INTEGRITY_POLICY,
  enforceIntegrityPolicy,
  evaluateIntegrityPolicy,
  getIntegrityPolicy,
  getLastIntegrityWarning,
  normalizeIntegrityPolicy,
  onIntegrityWarning,
  resetIntegrityDetector,
  setIntegrityDetector,
  type DeviceIntegrityResult,
  type IntegrityPolicy,
} from "../deviceIntegrity";

const deviceMock = Device as unknown as {
  isRootedExperimentalAsync: jest.Mock;
};

const clean: DeviceIntegrityResult = {
  isCompromised: false,
  reasons: [],
  supported: true,
};

const compromised: DeviceIntegrityResult = {
  isCompromised: true,
  reasons: ["mock: rooted/jailbroken"],
  supported: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  deviceMock.isRootedExperimentalAsync.mockResolvedValue(false);
});

afterEach(() => {
  resetIntegrityDetector();
});

describe("getIntegrityPolicy", () => {
  test("returns the inlined env value, defaulting to block when unset", () => {
    // Expo inlines `process.env.EXPO_PUBLIC_DEVICE_INTEGRITY_POLICY` at
    // transform time, so at jest runtime the value is whatever was set when
    // the suite was compiled (unset here) → the default policy.
    expect(getIntegrityPolicy()).toBe<IntegrityPolicy>("block");
  });
});

describe("normalizeIntegrityPolicy", () => {
  test("defaults to block when the raw value is unset or blank", () => {
    expect(normalizeIntegrityPolicy(undefined)).toBe<IntegrityPolicy>("block");
    expect(normalizeIntegrityPolicy("")).toBe<IntegrityPolicy>("block");
    expect(normalizeIntegrityPolicy("   ")).toBe<IntegrityPolicy>("block");
  });

  test("accepts valid values, trimming and lowercasing", () => {
    for (const policy of ["off", "warn", "block"] as const) {
      expect(normalizeIntegrityPolicy(policy)).toBe<IntegrityPolicy>(policy);
      expect(normalizeIntegrityPolicy(`  ${policy.toUpperCase()}  `)).toBe<
        IntegrityPolicy
      >(policy);
    }
  });

  test("falls back to block for an invalid value", () => {
    expect(normalizeIntegrityPolicy("explode")).toBe<IntegrityPolicy>(
      DEFAULT_INTEGRITY_POLICY,
    );
  });
});

describe("evaluateIntegrityPolicy", () => {
  test("clean device always allows, regardless of policy", () => {
    for (const policy of ["off", "warn", "block"] as const) {
      expect(evaluateIntegrityPolicy(clean, policy)).toEqual({
        action: "allow",
        policy,
        isCompromised: false,
        result: clean,
      });
    }
  });

  test("block policy blocks a compromised device", () => {
    expect(evaluateIntegrityPolicy(compromised, "block").action).toBe("block");
  });

  test("warn policy warns on a compromised device", () => {
    expect(evaluateIntegrityPolicy(compromised, "warn").action).toBe("warn");
  });

  test("off policy allows a compromised device", () => {
    expect(evaluateIntegrityPolicy(compromised, "off").action).toBe("allow");
  });
});

describe("checkDeviceIntegrity + enforceIntegrityPolicy", () => {
  test("delegates to the injected detector", async () => {
    setIntegrityDetector(async () => compromised);
    await expect(checkDeviceIntegrity()).resolves.toEqual(compromised);
  });

  test("returns a block decision for a compromised device under block policy", async () => {
    setIntegrityDetector(async () => compromised);
    const decision = await enforceIntegrityPolicy("block");
    expect(decision.action).toBe("block");
    expect(decision.isCompromised).toBe(true);
  });

  test("returns a warn decision for a compromised device under warn policy", async () => {
    setIntegrityDetector(async () => compromised);
    const decision = await enforceIntegrityPolicy("warn");
    expect(decision.action).toBe("warn");
    expect(decision.isCompromised).toBe(true);
  });

  test("returns an allow decision for a clean device under block policy", async () => {
    setIntegrityDetector(async () => clean);
    const decision = await enforceIntegrityPolicy("block");
    expect(decision.action).toBe("allow");
    expect(decision.isCompromised).toBe(false);
  });
});

describe("default (expo-device) detector", () => {
  test("reports clean when isRootedExperimentalAsync resolves false", async () => {
    deviceMock.isRootedExperimentalAsync.mockResolvedValueOnce(false);
    await expect(checkDeviceIntegrity()).resolves.toEqual({
      isCompromised: false,
      reasons: [],
      supported: true,
    });
  });

  test("reports compromised when isRootedExperimentalAsync resolves true", async () => {
    deviceMock.isRootedExperimentalAsync.mockResolvedValueOnce(true);
    await expect(checkDeviceIntegrity()).resolves.toMatchObject({
      isCompromised: true,
      supported: true,
    });
  });

  test("fails open (supported: false) when the detector throws", async () => {
    deviceMock.isRootedExperimentalAsync.mockRejectedValueOnce(
      new Error("native module unavailable"),
    );
    await expect(checkDeviceIntegrity()).resolves.toEqual({
      isCompromised: false,
      reasons: [],
      supported: false,
    });
  });
});

describe("warning surfacing", () => {
  test("records the reason on warn and block decisions", () => {
    evaluateIntegrityPolicy(compromised, "warn");
    expect(getLastIntegrityWarning()).toBe("mock: rooted/jailbroken");
  });

  test("notifies listeners without breaking when one throws", () => {
    const seen: string[] = [];
    const unsub = onIntegrityWarning((w) => seen.push(w));
    onIntegrityWarning(() => {
      throw new Error("bad listener");
    });

    evaluateIntegrityPolicy(compromised, "block");

    expect(seen).toEqual(["mock: rooted/jailbroken"]);
    unsub();
  });
});
