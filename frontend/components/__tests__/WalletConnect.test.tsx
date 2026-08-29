/**
 * __tests__/WalletConnect.test.tsx
 *
 * Behavioral tests for WalletConnect covering multi-wallet detection,
 * connection flow, error handling, and the no-wallets-installed state.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import WalletConnect from "../WalletConnect";

// Mock the wallet registry to return controlled wallet lists
const mockGetAvailableWallets = jest.fn();

jest.mock("@/lib/wallets", () => ({
  getAvailableWallets: (...args: unknown[]) => mockGetAvailableWallets(...args),
  getWalletById: jest.fn(),
  resolveDefaultWallet: jest.fn(),
  persistWalletSelection: jest.fn(),
  clearWalletSelection: jest.fn(),
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

function makeWalletAdapter(overrides: Record<string, unknown> = {}) {
  return {
    id: "freighter",
    name: "Freighter",
    description: "The most popular Stellar wallet.",
    installUrl: "https://freighter.app",
    isInstalled: jest.fn().mockResolvedValue(true),
    connect: jest.fn().mockResolvedValue(undefined),
    getPublicKey: jest.fn().mockResolvedValue("GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890"),
    signTransaction: jest.fn().mockResolvedValue("signed-xdr"),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Default: one wallet (Freighter) is available
  mockGetAvailableWallets.mockResolvedValue([makeWalletAdapter()]);
});

describe("WalletConnect", () => {
  it("shows detection spinner while discovering wallets", () => {
    // Don't resolve the promise — stay in "detecting" state
    mockGetAvailableWallets.mockReturnValue(new Promise(() => {}));
    render(<WalletConnect onConnect={jest.fn()} />);
    expect(screen.getByText(/detecting stellar wallets/i)).toBeInTheDocument();
  });

  it("shows install prompt when no wallets are detected", async () => {
    mockGetAvailableWallets.mockResolvedValue([]);
    render(<WalletConnect onConnect={jest.fn()} />);
    await waitFor(() => {
      expect(screen.getByText(/install a stellar wallet/i)).toBeInTheDocument();
    });
    // Shows install links for other wallets
    expect(screen.getByText(/Albedo/)).toBeInTheDocument();
    expect(screen.getByText(/xBull/)).toBeInTheDocument();
    expect(screen.getByText(/WalletConnect/)).toBeInTheDocument();
  });

  it("renders wallet options when wallets are available", async () => {
    mockGetAvailableWallets.mockResolvedValue([
      makeWalletAdapter({ id: "freighter", name: "Freighter" }),
      makeWalletAdapter({ id: "albedo", name: "Albedo" }),
    ]);
    render(<WalletConnect onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Freighter")).toBeInTheDocument();
    });
    expect(screen.getByText("Albedo")).toBeInTheDocument();
    expect(screen.getByText(/2 wallets detected/i)).toBeInTheDocument();
  });

  it("calls getPublicKey and onConnect when a wallet is clicked", async () => {
    const user = userEvent.setup();
    const onConnect = jest.fn();
    const adapter = makeWalletAdapter();
    mockGetAvailableWallets.mockResolvedValue([adapter]);

    render(<WalletConnect onConnect={onConnect} />);

    await waitFor(() => {
      expect(screen.getByText("Freighter")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("wallet-connect-button"));

    expect(adapter.connect).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(onConnect).toHaveBeenCalledWith(
        "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890",
      );
    });
  });

  it("shows error message when wallet connection fails", async () => {
    const user = userEvent.setup();
    const adapter = makeWalletAdapter({
      connect: jest.fn().mockRejectedValue(new Error("Connection rejected.")),
    });
    mockGetAvailableWallets.mockResolvedValue([adapter]);

    render(<WalletConnect onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Freighter")).toBeInTheDocument();
    });

    await user.click(screen.getByTestId("wallet-connect-button"));

    await waitFor(() => {
      expect(screen.getByText("Connection rejected.")).toBeInTheDocument();
    });
  });

  it("shows single connect button when only one wallet is available", async () => {
    mockGetAvailableWallets.mockResolvedValue([makeWalletAdapter()]);
    render(<WalletConnect onConnect={jest.fn()} />);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-connect-button")).toBeInTheDocument();
    });
    // Only one wallet card shown
    expect(screen.getAllByTestId("wallet-connect-button")).toHaveLength(1);
  });
});
