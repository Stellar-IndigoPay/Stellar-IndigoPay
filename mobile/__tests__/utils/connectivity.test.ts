/**
 * __tests__/utils/connectivity.test.ts
 *
 * Unit tests for the lightweight connectivity monitor.
 */
import axios from "axios";

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn() }) }), {
  virtual: true,
});

import {
  subscribe,
  isOnline,
  startConnectivityWatcher,
  stopConnectivityWatcher,
  checkNow,
} from "../../utils/connectivity";

beforeEach(() => {
  jest.clearAllMocks();
  (axios.get as jest.Mock).mockReset();
  stopConnectivityWatcher();
});

describe("connectivity monitor", () => {
  test("reports offline when the health probe fails", async () => {
    (axios.get as jest.Mock).mockRejectedValue(new Error("network down"));
    const result = await checkNow(false);
    expect(result).toBe(false);
    expect(isOnline()).toBe(false);
  });

  test("reports online when the health probe succeeds", async () => {
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data: {} });
    const result = await checkNow(false);
    expect(result).toBe(true);
    expect(isOnline()).toBe(true);
  });

  test("notifies subscribers immediately and on each transition", async () => {
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data: {} });
    await checkNow(false); // initial online=true

    const listener = jest.fn();
    subscribe(listener);
    // subscribe() emits the current state on a microtask
    await Promise.resolve();

    // subscribe() emits the current state immediately (online=true)
    expect(listener).toHaveBeenCalledWith(true);
    listener.mockClear();

    // Same state (online) → no transition → no notify
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data: {} });
    await checkNow();
    expect(listener).not.toHaveBeenCalled();

    // Transition to offline → notify
    (axios.get as jest.Mock).mockRejectedValue(new Error("down"));
    await checkNow();
    expect(listener).toHaveBeenCalledWith(false);
  });

  test("startConnectivityWatcher sets up a probe interval", () => {
    (axios.get as jest.Mock).mockResolvedValue({ status: 200, data: {} });
    startConnectivityWatcher();
    // Calling twice is idempotent (no second timer).
    startConnectivityWatcher();
    expect(axios.get).toHaveBeenCalled();
    stopConnectivityWatcher();
  });
});
