/**
 * components/__tests__/AuthGate.test.tsx
 *
 * Unit tests for the AuthGate wrapper component that gates sensitive
 * screens behind a biometric unlock.
 *
 * Coverage:
 *   - renders children when useAuth().state === 'unlocked'
 *   - shows friendly "Unlock to continue" UI when state === 'locked'
 *   - shows a busy state (ActivityIndicator) while isUnlocking === true
 *   - tapping Unlock calls useAuth().unlock()
 *   - custom prompt copy overrides the defaults
 */
import React, { type ReactNode } from "react";
import { Text, Pressable, View } from "react-native";
import { render, screen, fireEvent } from "@testing-library/react-native";

jest.mock("../../providers/AuthProvider", () => ({
  useAuth: jest.fn(),
}));

import { useAuth } from "../../providers/AuthProvider";
import { AuthGate } from "../AuthGate";

const useAuthMock = useAuth as jest.MockedFunction<typeof useAuth>;

interface MockOverrides {
  state?: "hydrating" | "locked" | "unlocked" | "cleared";
  isAuthenticated?: boolean;
  isUnlocking?: boolean;
  unlock?: jest.Mock;
}

function setAuth(overrides: MockOverrides = {}) {
  const unlock = overrides.unlock ?? jest.fn().mockResolvedValue(true);
  useAuthMock.mockReturnValue({
    state: overrides.state ?? "locked",
    isAuthenticated: overrides.isAuthenticated ?? false,
    isUnlocking: overrides.isUnlocking ?? false,
    session: null,
    unlock,
    lock: jest.fn(),
    clear: jest.fn().mockResolvedValue(undefined),
    storeSession: jest.fn().mockResolvedValue(true),
  });
  return unlock;
}

beforeEach(() => {
  useAuthMock.mockReset();
});

describe("AuthGate", () => {
  test("renders children when AuthProvider reports unlocked", () => {
    setAuth({ state: "unlocked", isAuthenticated: true });
    render(
      <AuthGate>
        <Text testID="children-marker">secret content</Text>
      </AuthGate>,
    );
    expect(screen.getByTestId("children-marker")).toBeTruthy();
  });

  test('renders friendly "Unlock to continue" UI when locked', () => {
    setAuth({ state: "locked" });
    render(
      <AuthGate>
        <Text testID="children-marker">secret content</Text>
      </AuthGate>,
    );

    expect(screen.queryByTestId("children-marker")).toBeNull();
    expect(screen.getByText(/Unlock to continue/i)).toBeTruthy();
    const btn = screen.getByRole("button", { name: /unlock indigopay/i });
    expect(btn).toBeTruthy();
  });

  test("pressing the unlock button calls unlock()", () => {
    const unlock = setAuth({ state: "locked" });
    render(
      <AuthGate>
        <Text testID="children-marker">secret content</Text>
      </AuthGate>,
    );
    fireEvent.press(screen.getByRole("button", { name: /unlock indigopay/i }));
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  test("disables the button while isUnlocking=true", () => {
    setAuth({ state: "locked", isUnlocking: true });
    render(
      <AuthGate>
        <Text>secret</Text>
      </AuthGate>,
    );
    const btn = screen.getByRole("button", { name: /unlock indigopay/i });
    expect(btn.props.accessibilityState).toEqual(
      expect.objectContaining({ disabled: true }),
    );
  });

  test("custom prompt copy overrides the defaults", () => {
    setAuth({ state: "locked" });
    render(
      <AuthGate
        promptTitle="Confirm donation"
        promptBody="Tap unlock to authorise this transfer."
      >
        <Text>secret</Text>
      </AuthGate>,
    );

    expect(screen.getByText(/Confirm donation/i)).toBeTruthy();
    expect(screen.getByText(/authorise this transfer/i)).toBeTruthy();
  });

  test('renders "Set up IndigoPay" Connect-wallet CTA when state="cleared"', () => {
    const unlock = setAuth({ state: "cleared" });
    render(
      <AuthGate>
        <Text testID="children-marker">secret</Text>
      </AuthGate>,
    );

    expect(screen.queryByTestId("children-marker")).toBeNull();
    expect(screen.getByText(/Set up IndigoPay/i)).toBeTruthy();
    const cta = screen.getByRole("button", {
      name: /Connect a Stellar wallet/i,
    });
    expect(cta).toBeTruthy();

    // The Connect-wallet CTA is intentionally a no-op for Phase 1.
    // It MUST NOT invoke useAuth().unlock() — that would dead-end for
    // a user with no stored session (state === 'cleared').
    fireEvent.press(cta);
    expect(unlock).not.toHaveBeenCalled();
  });

  test('renders spinner only (no Unlock/Connect button) when state="hydrating"', () => {
    setAuth({ state: "hydrating" });
    render(
      <AuthGate>
        <Text testID="children-marker">secret</Text>
      </AuthGate>,
    );

    expect(screen.queryByTestId("children-marker")).toBeNull();
    expect(screen.getByText(/Loading…/i)).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /unlock indigopay/i }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Connect a Stellar wallet/i }),
    ).toBeNull();
  });
});
