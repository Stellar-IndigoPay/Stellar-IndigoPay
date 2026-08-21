/**
 * Tests for the RETRY_API_CONNECTION message handler in background.ts
 * (issue #908 CodeRabbit follow-up: a user-initiated Retry click must
 * actually attempt an API request — only a real apiFetch() call can
 * acquire a half-open trial slot and give a recovered backend a chance to
 * close the breaker. Re-reading the snapshot via GET_API_STATUS alone
 * can never advance a tripped breaker.)
 *
 * Unlike background.test.ts (which avoids importing the module because of
 * its side effects at import time — contextMenus, onInstalled, etc.), this
 * file imports it directly: those side effects are all backed by the
 * jest.setup.js chrome mock, and driving the real onMessage listener is
 * the only way to exercise the actual RETRY_API_CONNECTION wiring instead
 * of a re-implemented stand-in.
 */

import { __resetApiClientRuntimeStateForTests } from "../lib/apiClient";

type MessageListener = (
  message: any,
  sender: any,
  sendResponse: (response?: any) => void,
) => boolean | void;

const API_BASE = "https://api.stellar-indigopay.app";
const API_HOST = "api.stellar-indigopay.app";

function installLocalStorageMock(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  (globalThis as any).chrome.storage.local.get = jest.fn(
    (keys: string[], callback: (result: Record<string, unknown>) => void) => {
      const result: Record<string, unknown> = {};
      keys.forEach((key) => {
        if (store.has(key)) result[key] = store.get(key);
      });
      callback(result);
    },
  );
  (globalThis as any).chrome.storage.local.set = jest.fn(
    (items: Record<string, unknown>, callback?: () => void) => {
      Object.entries(items).forEach(([key, value]) => store.set(key, value));
      if (callback) callback();
    },
  );
  return store;
}

function installSyncSettingsMock(backendUrl: string): void {
  (globalThis as any).chrome.storage.sync.get = jest.fn(
    (_keys: string[], callback: (result: Record<string, unknown>) => void) => {
      callback({ backendUrl, network: "testnet", defaultDonationAmount: "5" });
    },
  );
}

function send(
  listener: MessageListener,
  message: any,
): Promise<any> {
  return new Promise((resolve) => {
    listener(message, {}, (response?: any) => resolve(response));
  });
}

describe("background.ts RETRY_API_CONNECTION / GET_API_STATUS", () => {
  let originalFetch: typeof fetch;
  let onMessage: MessageListener;

  beforeAll(async () => {
    originalFetch = globalThis.fetch;
    installLocalStorageMock();
    installSyncSettingsMock(API_BASE);

    await import("../background");

    const addListenerMock = (globalThis as any).chrome.runtime.onMessage
      .addListener as jest.Mock;
    // background.ts registers exactly one onMessage listener.
    onMessage = addListenerMock.mock.calls[addListenerMock.mock.calls.length - 1][0];
  });

  beforeEach(() => {
    installLocalStorageMock();
    installSyncSettingsMock(API_BASE);
    __resetApiClientRuntimeStateForTests();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  test("GET_API_STATUS reports the current breaker snapshot without calling fetch", async () => {
    const mockFetch = jest.fn();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const response = await send(onMessage, { type: "GET_API_STATUS" });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(response.status.state).toBe("closed");
  });

  test("RETRY_API_CONNECTION issues a real request against the API host", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [] }),
    });
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    const response = await send(onMessage, { type: "RETRY_API_CONNECTION" });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl] = mockFetch.mock.calls[0];
    expect(String(calledUrl)).toContain(API_HOST);
    expect(response.status.state).toBe("closed");
  });

  test("a Retry click can recover a tripped breaker (unlike GET_API_STATUS alone)", async () => {
    // Trip the breaker (default failureThreshold is 5 consecutive failures
    // — see DEFAULT_CIRCUIT_BREAKER_CONFIG in apiClientConfig.ts).
    const failingFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: async () => ({}),
    });
    globalThis.fetch = failingFetch as unknown as typeof fetch;
    for (let i = 0; i < 5; i += 1) {
      await send(onMessage, { type: "RETRY_API_CONNECTION" });
    }

    // A plain status read never touches the network and can't recover it.
    const beforeRecovery = await send(onMessage, { type: "GET_API_STATUS" });
    expect(beforeRecovery.status.state).toBe("open");
    expect(failingFetch).toHaveBeenCalledTimes(5);

    // Simulate the cooldown having elapsed (default cooldownMs is 30s) so
    // the breaker allows a half-open trial, then have the backend recover.
    // The default halfOpenSuccessThreshold is 2, so it takes two
    // successful Retry clicks to fully close the breaker again.
    const nowAfterCooldown = Date.now() + 40_000;
    jest.spyOn(Date, "now").mockReturnValue(nowAfterCooldown);
    const recoveringFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ data: [] }),
    });
    globalThis.fetch = recoveringFetch as unknown as typeof fetch;

    const firstTrial = await send(onMessage, { type: "RETRY_API_CONNECTION" });
    expect(firstTrial.status.state).toBe("half_open"); // one success, not fully closed yet

    const secondTrial = await send(onMessage, { type: "RETRY_API_CONNECTION" });

    expect(recoveringFetch).toHaveBeenCalledTimes(2);
    expect(secondTrial.status.state).toBe("closed");
  });
});
