/**
 * lib/__tests__/apiClient.test.ts
 *
 * Unit tests for `lib/apiClient.ts` — the centralized, pinned HTTP client.
 *
 * The axios module is mocked via `__mocks__/axios.js` (its `create()` returns
 * the same mock object, so `apiClient.get === axios.get`), which lets us drive
 * the typed helpers with the standard axios mocks while testing the pinning
 * enforcement (assertPinningAllowed / verifier / fail-closed behavior)
 * directly.
 */
import axios from "axios";
import {
  API_URL,
  apiClient,
  apiGet,
  apiPost,
  assertPinningAllowed,
  pinnedFetch,
  registerPinningVerifier,
  setPinningAllowlist,
  setPinningPolicy,
  PinningVerifier,
} from "../apiClient";
import { PinningError, createHostPolicy, PinRegistry } from "../pinning";

const PIN_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const PIN_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";

const PINNED_HOST = "api.indigopay.org";
const PINNED_URL = `https://${PINNED_HOST}/api/projects`;

function pinnedPolicy() {
  return {
    [PINNED_HOST]: createHostPolicy(PINNED_HOST, { pins: [`sha256/${PIN_A}`] }),
  };
}

describe("assertPinningAllowed", () => {
  beforeEach(() => {
    registerPinningVerifier(null);
    setPinningAllowlist([]);
    setPinningPolicy({});
    jest.restoreAllMocks();
  });

  test("allows localhost / loopback hosts", () => {
    expect(() =>
      assertPinningAllowed("http://localhost:4000/api/health", { isDev: false }),
    ).not.toThrow();
  });

  test("allows unconfigured hosts in dev builds", () => {
    expect(() =>
      assertPinningAllowed("https://unconfigured.example.com/x", { isDev: true }),
    ).not.toThrow();
  });

  test("allows hosts in the dev allowlist even when pinned", () => {
    setPinningPolicy(pinnedPolicy());
    setPinningAllowlist([PINNED_HOST]);
    expect(() =>
      assertPinningAllowed(PINNED_URL, { isDev: false }),
    ).not.toThrow();
  });

  test("fails closed in production when a pinned host has no verifier", () => {
    setPinningPolicy(pinnedPolicy());
    try {
      assertPinningAllowed(PINNED_URL, { isDev: false });
      throw new Error("expected assertPinningAllowed to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(PinningError);
      expect((err as PinningError).code).toBe("PINNING_NOT_ENFORCED");
    }
  });

  test("runs the registered verifier and rejects on mismatch", () => {
    setPinningPolicy(pinnedPolicy());
    const verifier: PinningVerifier = {
      verify: () => {
        throw new PinningError(
          "PIN_MISMATCH",
          PINNED_HOST,
          "Certificate pin mismatch",
        );
      },
    };
    registerPinningVerifier(verifier);
    expect(() => assertPinningAllowed(PINNED_URL, { isDev: false })).toThrow(
      /PIN_MISMATCH/,
    );
  });

  test("runs the registered verifier and allows on match", () => {
    setPinningPolicy(pinnedPolicy());
    const verifier: PinningVerifier = { verify: () => undefined };
    registerPinningVerifier(verifier);
    expect(() =>
      assertPinningAllowed(PINNED_URL, { isDev: false }),
    ).not.toThrow();
  });

  test("does not invoke the verifier for bypassed hosts", () => {
    setPinningPolicy(pinnedPolicy());
    const verify = jest.fn();
    registerPinningVerifier({ verify });
    assertPinningAllowed("http://localhost:4000/x", { isDev: false });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe("apiClient typed helpers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("apiGet unwraps response.data through the shared axios client", async () => {
    (axios.get as jest.Mock).mockResolvedValueOnce({
      data: { success: true, data: [{ id: "p1" }] },
    });
    const result = await apiGet("/api/projects");
    expect(result).toEqual({ success: true, data: [{ id: "p1" }] });
    expect(axios.get).toHaveBeenCalledWith("/api/projects", undefined);
  });

  test("apiPost unwraps response.data and passes the body", async () => {
    (axios.post as jest.Mock).mockResolvedValueOnce({
      data: { success: true, data: { id: "d1" } },
    });
    const body = { projectId: "p1", amountXLM: "5" };
    const result = await apiPost("/api/donations", body);
    expect(result).toEqual({ success: true, data: { id: "d1" } });
    expect(axios.post).toHaveBeenCalledWith("/api/donations", body, undefined);
  });

  test("apiClient exposes the expected base URL", () => {
    expect(API_URL).toBe(process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000");
    expect(apiClient).toBeDefined();
  });
});

describe("pinnedFetch", () => {
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
    registerPinningVerifier(null);
    setPinningPolicy({});
  });

  test("asserts pinning then delegates to fetch", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    await pinnedFetch("http://localhost:4000/api/health");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("rejects pinned hosts when the verifier reports a mismatch", async () => {
    setPinningPolicy(pinnedPolicy());
    registerPinningVerifier({
      verify: () => {
        throw new PinningError("PIN_MISMATCH", PINNED_HOST, "Mismatch");
      },
    });
    await expect(pinnedFetch(PINNED_URL)).rejects.toMatchObject({
      code: "PIN_MISMATCH",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("accepts a RequestInfo object (reads .url)", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true });
    const request = { url: "http://localhost:4000/api/health" } as RequestInfo;
    await pinnedFetch(request);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// A small regression guard: the registry returned by getPinningRegistry is a
// PinRegistry with the env-loaded default policy.
import { getPinningRegistry } from "../apiClient";
describe("pinning registry wiring", () => {
  test("getPinningRegistry returns a PinRegistry", () => {
    expect(getPinningRegistry()).toBeInstanceOf(PinRegistry);
  });
});
