import React from "react";
import { render, fireEvent, waitFor } from "@testing-library/react-native";
import SEP0007Screen from "../sep0007";

const mockUseAuth = jest.fn();
const mockUseRouter = jest.fn();
const mockUseBiometricAuth = jest.fn();
const mockLinkingUseURL = jest.fn();
const mockOpenURL = jest.fn();
const mockAuthenticateAsync = jest.fn();
const VALID_PUBLIC_KEY = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGSNFHEYVXM3XOJMDS674JZ";

jest.mock("../../providers/AuthProvider", () => ({
  useAuth: () => mockUseAuth(),
}));

jest.mock("expo-router", () => ({
  useRouter: () => mockUseRouter(),
  useLocalSearchParams: () => ({ uri: undefined }),
}));

jest.mock("../../hooks/useBiometricAuth", () => ({
  useBiometricAuth: () => mockUseBiometricAuth(),
}));

jest.mock("expo-linking", () => ({
  useURL: () => mockLinkingUseURL(),
  openURL: (...args: any[]) => mockOpenURL(...args),
}));

jest.mock("expo-local-authentication", () => ({
  authenticateAsync: (...args: any[]) => mockAuthenticateAsync(...args),
}));

jest.mock("../../lib/wallet/sdk", () => ({
  loadSecretKey: jest.fn().mockResolvedValue("SSECRET"),
  signTransaction: jest.fn().mockReturnValue({ signedXDR: "xdr", transactionHash: "hash123" }),
  submitTransaction: jest.fn().mockResolvedValue({ hash: "hash123", ledger: 1 }),
  buildPaymentTransaction: jest.fn().mockResolvedValue("xdr"),
}));

describe("SEP0007Screen", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseAuth.mockReturnValue({ session: { publicKey: VALID_PUBLIC_KEY }, isAuthenticated: true });
    mockUseRouter.mockReturnValue({ replace: jest.fn() });
    mockUseBiometricAuth.mockReturnValue({ confirmDonation: jest.fn().mockResolvedValue({ success: true }) });
    mockLinkingUseURL.mockReturnValue(`web+stellar:pay?destination=${VALID_PUBLIC_KEY}&amount=50&memo=donation`);
    mockAuthenticateAsync.mockResolvedValue({ success: true });
    mockOpenURL.mockResolvedValue(undefined);
  });

  it("renders the confirmation screen with destination, amount, and memo", () => {
    const { getByText } = render(<SEP0007Screen />);
    expect(getByText("Payment request")).toBeTruthy();
    expect(getByText(/Destination/i)).toBeTruthy();
    expect(getByText(/50/i)).toBeTruthy();
    expect(getByText(/donation/i)).toBeTruthy();
  });

  it("shows an error state for missing destination", () => {
    mockLinkingUseURL.mockReturnValue(`web+stellar:pay?amount=50`);
    const { getByText } = render(<SEP0007Screen />);
    expect(getByText(/Invalid payment request/i)).toBeTruthy();
  });

  it("triggers biometric confirmation before submitting", async () => {
    const { getByText } = render(<SEP0007Screen />);
    fireEvent.press(getByText("Confirm & Pay"));
    await waitFor(() => expect(mockAuthenticateAsync).toHaveBeenCalled());
  });

  it("opens the callback URL after success", async () => {
    mockLinkingUseURL.mockReturnValue(`web+stellar:pay?destination=${VALID_PUBLIC_KEY}&amount=50&memo=donation&callback=https%3A%2F%2Fexample.com%2Fdone`);
    const { getByText } = render(<SEP0007Screen />);
    fireEvent.press(getByText("Confirm & Pay"));
    await waitFor(() => expect(mockOpenURL).toHaveBeenCalled());
  });

  it("renders an error when the app is locked", () => {
    mockUseAuth.mockReturnValue({ session: null, isAuthenticated: false });
    const { getAllByText } = render(<SEP0007Screen />);
    expect(getAllByText(/Unlock your wallet/i).length).toBeGreaterThan(0);
  });

  it("renders an error for invalid amount", () => {
    mockLinkingUseURL.mockReturnValue(`web+stellar:pay?destination=${VALID_PUBLIC_KEY}&amount=abc`);
    const { getByText } = render(<SEP0007Screen />);
    expect(getByText(/Invalid payment request/i)).toBeTruthy();
  });
});
