/**
 * __tests__/WalletConnect.test.tsx
 *
 * Behavioral tests for WalletConnect covering connect/disconnect flow,
 * address display, error handling, and Freighter detection.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WalletConnect from "../WalletConnect";

const mockConnectWallet = jest.fn();
const mockIsFreighterInstalled = jest.fn();

jest.mock("@/lib/wallet", () => ({
  connectWallet: (...args: unknown[]) => mockConnectWallet(...args),
  isFreighterInstalled: (...args: unknown[]) => mockIsFreighterInstalled(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: jest.fn(),
    t: (key: string) => {
      const translations: Record<string, string> = {
        "wallet.connectTitle": "Connect Your Wallet",
        "wallet.connectDesc": "Use Freighter to donate XLM directly to climate projects with zero platform fees.",
        "wallet.connectBtn": "Connect Freighter Wallet",
        "wallet.connecting": "Connecting...",
        "wallet.noWallet": "No wallet?",
        "wallet.installFreighter": "Install Freighter →",
      };
      return translations[key] ?? key;
    },
  }),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockIsFreighterInstalled.mockResolvedValue(true);
});

describe("WalletConnect", () => {
  it("renders the connect button when no wallet is connected", () => {
    render(<WalletConnect onConnect={jest.fn()} />);
    expect(
      screen.getByRole("button", { name: /connect freighter wallet/i }),
    ).toBeInTheDocument();
  });

  it("calls connectWallet on button click and invokes onConnect", async () => {
    const user = userEvent.setup();
    const onConnect = jest.fn();
    mockConnectWallet.mockResolvedValue({
      publicKey: "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
      error: null,
    });

    render(<WalletConnect onConnect={onConnect} />);
    await user.click(
      screen.getByRole("button", { name: /connect freighter wallet/i }),
    );

    expect(mockConnectWallet).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(
        "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
      );
    });
  });

  it("shows error message when connection fails", async () => {
    const user = userEvent.setup();
    mockConnectWallet.mockResolvedValue({
      publicKey: null,
      error: "Connection rejected.",
    });

    render(<WalletConnect onConnect={jest.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /connect freighter wallet/i }),
    );

    await waitFor(() => {
      expect(screen.getByText("Connection rejected.")).toBeInTheDocument();
    });
  });

  it("opens Freighter install page when wallet is not installed", async () => {
    const user = userEvent.setup();
    mockIsFreighterInstalled.mockResolvedValue(false);
    const openSpy = jest.spyOn(window, "open").mockImplementation();

    render(<WalletConnect onConnect={jest.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /connect freighter wallet/i }),
    );

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith("https://freighter.app", "_blank");
    });
    openSpy.mockRestore();
  });

  it("shows the Freighter installation link", () => {
    render(<WalletConnect onConnect={jest.fn()} />);
    expect(screen.getByText(/install freighter/i)).toHaveAttribute(
      "href",
      "https://freighter.app",
    );
  });

  it("displays a loading spinner while connecting", async () => {
    const user = userEvent.setup();
    let resolveConnect!: (value: { publicKey: string | null; error: string | null }) => void;
    mockConnectWallet.mockImplementation(
      () => new Promise((resolve) => { resolveConnect = resolve; }),
    );

    render(<WalletConnect onConnect={jest.fn()} />);
    await user.click(
      screen.getByRole("button", { name: /connect freighter wallet/i }),
    );

    await waitFor(() => {
      expect(screen.getByText(/connecting/i)).toBeInTheDocument();
    });

    resolveConnect({ publicKey: null, error: null });

    await waitFor(() => {
      expect(screen.queryByText(/connecting/i)).not.toBeInTheDocument();
    });
  });
});
