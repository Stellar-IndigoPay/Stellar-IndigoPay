/**
 * providers/__tests__/AuthProvider.test.tsx
 *
 * Unit tests for `providers/AuthProvider.tsx` covering:
 *   - cold-start hydration: 'cleared' when no stored session,
 *     'locked' when a stored session exists
 *   - unlock(): requires authenticate() success before in-memory session
 *     is restored; failure does NOT transition state
 *   - lock(): 'unlocked' → 'locked' without erasing storage
 *   - clear(): wipes SecureStore and resets state to 'cleared'
 *   - storeSession(): persists + unlocks
 *   - AppState background >= 60s auto-locks
 *   - useAuth() outside the provider returns the no-op fallback safely
 */
import React, { type ReactNode } from "react";
import {
  act,
  fireEvent,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react-native";

jest.mock("../../lib/secureStore");
jest.mock("../../hooks/useBiometricAuth");
jest.mock("../../lib/deviceIntegrity", () => ({
  checkDeviceIntegrity: jest.fn(),
  enforceIntegrityPolicy: jest.fn(),
  getIntegrityPolicy: jest.fn(() => "block"),
}));
import * as secureStore from "../../lib/secureStore";
import * as biometricAuth from "../../hooks/useBiometricAuth";
import * as deviceIntegrity from "../../lib/deviceIntegrity";
jest.mock("react-native", () => {
  const RN = jest.requireActual("react-native");
  const mockAppState = {
    ...RN.AppState,
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  };
  return new Proxy(RN, {
    get(target, prop) {
      if (prop === "AppState") {
        return mockAppState;
      }
      return target[prop];
    },
  });
});

import { AppState } from "react-native";

import {
  AuthProvider,
  useAuth,
  type AuthState,
  type WalletSession,
} from "../AuthProvider";

const ssMock = secureStore as unknown as {
  get: jest.Mock;
  set: jest.Mock;
  remove: jest.Mock;
};
const authMock = biometricAuth as unknown as {
  authenticate: jest.Mock;
};
const appStateMock = AppState as unknown as {
  addEventListener: jest.Mock;
};
const integrityMock = deviceIntegrity as unknown as {
  checkDeviceIntegrity: jest.Mock;
  enforceIntegrityPolicy: jest.Mock;
  getIntegrityPolicy: jest.Mock;
};

const sampleSession: WalletSession = {
  publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  network: "TESTNET",
  authNonce: "nonce-123",
  lastLoginAt: 1_700_000_000,
};

beforeEach(() => {
  ssMock.get.mockReset();
  ssMock.set.mockReset();
  ssMock.remove.mockReset();
  authMock.authenticate.mockReset();
  appStateMock.addEventListener.mockReset();
  appStateMock.addEventListener.mockReturnValue({ remove: jest.fn() });
  integrityMock.checkDeviceIntegrity.mockResolvedValue({
    isCompromised: false,
    reasons: [],
    supported: true,
  });
  integrityMock.enforceIntegrityPolicy.mockReset();
  integrityMock.enforceIntegrityPolicy.mockResolvedValue({
    action: "allow",
    policy: "block",
    isCompromised: false,
    result: { isCompromised: false, reasons: [], supported: true },
  });
  integrityMock.getIntegrityPolicy.mockReturnValue("block");
});

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

describe("AuthProvider", () => {
  test('hydrates to "cleared" when no stored session', async () => {
    ssMock.get.mockResolvedValue(null);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("cleared"),
    );
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.session).toBeNull();
  });

  test("surfaces a compromised device via context", async () => {
    ssMock.get.mockResolvedValue(null);
    integrityMock.checkDeviceIntegrity.mockResolvedValue({
      isCompromised: true,
      reasons: ["mock rooted"],
      supported: true,
    });
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("cleared"));
    await waitFor(() => expect(result.current.isDeviceCompromised).toBe(true));
  });

  test('hydrates to "locked" when a stored session is present', async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.session).toBeNull(); // not exposed until unlock
  });

  test("unlock() restores session on biometric success", async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(true);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      const success = await result.current.unlock();
      expect(success).toBe(true);
    });
    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("unlocked"),
    );
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.session?.publicKey).toBe(sampleSession.publicKey);
  });

  test("unlock() does not transition when biometric prompt is cancelled", async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(false);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      const success = await result.current.unlock();
      expect(success).toBe(false);
    });
    // mockResolvedValueOnce already consumed; default keeps state.
    expect(result.current.state).toBe<AuthState>("locked");
  });

  test("unlock() refuses to authenticate or read the session on a compromised device under block policy", async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(true);
    integrityMock.enforceIntegrityPolicy.mockResolvedValue({
      action: "block",
      policy: "block",
      isCompromised: true,
      result: { isCompromised: true, reasons: ["mock rooted"], supported: true },
    });
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      const success = await result.current.unlock();
      expect(success).toBe(false);
    });
    expect(result.current.state).toBe<AuthState>("locked");
    expect(result.current.session).toBeNull();
    // Hydration reads once; the blocked unlock must not read again.
    expect(ssMock.get).toHaveBeenCalledTimes(1);
    expect(authMock.authenticate).not.toHaveBeenCalled();
  });

  test('lock() returns to "locked" without erasing storage', async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(true);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      await result.current.unlock();
    });
    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("unlocked"),
    );

    act(() => {
      result.current.lock();
    });
    expect(result.current.state).toBe<AuthState>("locked");
    expect(ssMock.remove).not.toHaveBeenCalled();
  });

  test("clear() wipes SecureStore and resets state to cleared", async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(true);
    ssMock.remove.mockResolvedValue(true);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      await result.current.clear();
    });
    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("cleared"),
    );
    expect(ssMock.remove).toHaveBeenCalledWith("wallet_session");
  });

  test("storeSession persists + unlocks", async () => {
    ssMock.get.mockResolvedValue(null);
    ssMock.set.mockResolvedValue(true);
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("cleared"),
    );

    await act(async () => {
      const ok = await result.current.storeSession({
        ...sampleSession,
        authNonce: "n2",
      });
      expect(ok).toBe(true);
    });
    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("unlocked"),
    );
    expect(ssMock.set).toHaveBeenCalledWith(
      "wallet_session",
      expect.objectContaining({ publicKey: sampleSession.publicKey }),
    );
  });

  test("storeSession() refuses to persist on a compromised device under block policy", async () => {
    ssMock.get.mockResolvedValue(null);
    ssMock.set.mockResolvedValue(true);
    integrityMock.enforceIntegrityPolicy.mockResolvedValue({
      action: "block",
      policy: "block",
      isCompromised: true,
      result: { isCompromised: true, reasons: ["mock rooted"], supported: true },
    });
    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("cleared"),
    );

    await act(async () => {
      const ok = await result.current.storeSession(sampleSession);
      expect(ok).toBe(false);
    });
    expect(ssMock.set).not.toHaveBeenCalled();
    expect(result.current.state).toBe<AuthState>("cleared");
    expect(result.current.session).toBeNull();
  });

  test("AppState background > 60s auto-locks when previously unlocked", async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(true);

    // Capture the listener registered during Provider mount.
    let listener: ((next: string) => void) | undefined;
    appStateMock.addEventListener.mockImplementationOnce(
      (event: string, fn: (next: string) => void) => {
        if (event === "change") listener = fn;
        return { remove: jest.fn() };
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      await result.current.unlock();
    });
    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("unlocked"),
    );
    expect(typeof listener).toBe("function");

    jest.useFakeTimers();
    try {
      await act(async () => {
        listener!("background");
        // Advance the wall clock past the 60s threshold.
        jest.advanceTimersByTime(61_000);
        listener!("active");
      });
    } finally {
      jest.useRealTimers();
    }

    expect(result.current.state).toBe<AuthState>("locked");
  });

  test("AppState quick switch (< 60s) does NOT auto-lock", async () => {
    ssMock.get.mockResolvedValue(sampleSession);
    authMock.authenticate.mockResolvedValue(true);

    let listener: ((next: string) => void) | undefined;
    appStateMock.addEventListener.mockImplementationOnce(
      (event: string, fn: (next: string) => void) => {
        if (event === "change") listener = fn;
        return { remove: jest.fn() };
      },
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current.state).toBe<AuthState>("locked"));
    await act(async () => {
      await result.current.unlock();
    });
    await waitFor(() =>
      expect(result.current.state).toBe<AuthState>("unlocked"),
    );

    jest.useFakeTimers();
    try {
      await act(async () => {
        listener!("background");
        jest.advanceTimersByTime(5_000);
        listener!("active");
      });
    } finally {
      jest.useRealTimers();
    }

    expect(result.current.state).toBe<AuthState>("unlocked");
  });
});

describe("useAuth outside provider", () => {
  test("returns the documented no-op fallback", () => {
    const { result } = renderHook(() => useAuth());
    expect(result.current.state).toBe<AuthState>("locked");
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.session).toBeNull();
  });
});
