import React from "react";
import { Text, Pressable, View } from "react-native";
import { render, act, waitFor, fireEvent } from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useBiometricAuth } from "../hooks/useBiometricAuth";

jest.setTimeout(20000);

const LA = LocalAuthentication as unknown as {
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  authenticateAsync: jest.Mock;
  supportedAuthenticationTypesAsync: jest.Mock;
};

// We mock AsyncStorage with a simple in-memory mock if the package mock isn't loaded
jest.mock("@react-native-async-storage/async-storage", () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn(async (key: string) => store[key] || null),
    setItem: jest.fn(async (key: string, value: string) => {
      store[key] = String(value);
    }),
    clear: jest.fn(async () => {
      store = {};
    }),
  };
});

beforeEach(() => {
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockClear();
  (AsyncStorage.setItem as jest.Mock).mockClear();
  LA.hasHardwareAsync.mockResolvedValue(true);
  LA.isEnrolledAsync.mockResolvedValue(true);
  LA.supportedAuthenticationTypesAsync.mockResolvedValue([
    LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
  ]);
  LA.authenticateAsync.mockResolvedValue({ success: true });
});

describe("useBiometricAuth (enhanced hook)", () => {
  function TestComponent({ amount }: { amount: number }) {
    const {
      isAvailable,
      biometricType,
      threshold,
      isEnabled,
      isAuthenticating,
      confirmDonation,
      setBiometricThreshold,
      setIsEnabled,
    } = useBiometricAuth();

    const status = [
      `isAvailable=${isAvailable}`,
      `biometricType=${biometricType}`,
      `threshold=${threshold}`,
      `isEnabled=${isEnabled}`,
      `isAuthenticating=${isAuthenticating}`,
    ].join("|");

    return (
      <View>
        <Text testID="status">{status}</Text>
        <Pressable
          testID="confirm-btn"
          onPress={() => confirmDonation(amount)}
        >
          <Text>Confirm</Text>
        </Pressable>
        <Pressable
          testID="set-threshold-btn"
          onPress={() => setBiometricThreshold(10)}
        >
          <Text>Set Threshold</Text>
        </Pressable>
        <Pressable
          testID="set-enabled-btn"
          onPress={() => setIsEnabled(false)}
        >
          <Text>Disable</Text>
        </Pressable>
      </View>
    );
  }

  it("probes the device and loads default preferences", async () => {
    const { getByTestId } = render(<TestComponent amount={100} />);

    await waitFor(() => {
      const status = getByTestId("status").props.children;
      expect(status).toMatch(/isAvailable=true/);
      expect(status).toMatch(/biometricType=Face ID/);
      expect(status).toMatch(/threshold=50/);
      expect(status).toMatch(/isEnabled=true/);
    });
  });

  it("skips authentication when amount is below threshold", async () => {
    const { getByTestId } = render(<TestComponent amount={20} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/isAvailable=true/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("confirm-btn"));
    });

    expect(LA.authenticateAsync).not.toHaveBeenCalled();
  });

  it("skips authentication when biometrics are unavailable", async () => {
    LA.hasHardwareAsync.mockResolvedValue(false);
    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/isAvailable=false/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("confirm-btn"));
    });

    expect(LA.authenticateAsync).not.toHaveBeenCalled();
  });

  it("triggers authentication when amount is above or equal to threshold", async () => {
    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/isAvailable=true/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("confirm-btn"));
    });

    expect(LA.authenticateAsync).toHaveBeenCalled();
  });

  it("saves preferences to AsyncStorage when updating settings", async () => {
    const { getByTestId } = render(<TestComponent amount={100} />);
    await waitFor(() => {
      expect(getByTestId("status").props.children).toMatch(/threshold=50/);
    });

    await act(async () => {
      fireEvent.press(getByTestId("set-threshold-btn"));
    });

    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "@indigopay:biometric_threshold",
        "10"
      );
    });

    await act(async () => {
      fireEvent.press(getByTestId("set-enabled-btn"));
    });

    await waitFor(() => {
      expect(AsyncStorage.setItem).toHaveBeenCalledWith(
        "@indigopay:biometric_enabled",
        "false"
      );
    });
  });
});
