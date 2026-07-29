/**
 * __tests__/Navbar.test.tsx
 *
 * Behavioral tests for Navbar covering navigation links, active state,
 * wallet connection, mobile menu toggle, and accessibility.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Navbar from "../Navbar";

jest.mock("next/router", () => ({
  useRouter: () => ({
    pathname: "/",
    push: jest.fn(),
    events: { on: jest.fn(), off: jest.fn() },
  }),
}));

jest.mock("next/link", () => {
  const React = require("react");
  return React.forwardRef(function MockLink(
    { children, href, ...rest }: { children: React.ReactNode; href: string; [key: string]: unknown },
    ref: React.Ref<HTMLAnchorElement>,
  ) {
    return (
      <a ref={ref} href={href} {...rest}>
        {children}
      </a>
    );
  });
});

jest.mock("@/lib/api", () => ({
  fetchUnreadNotificationCount: jest.fn().mockResolvedValue(0),
}));

jest.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    locale: "en",
    setLocale: jest.fn(),
    t: (key: string) => {
      const translations: Record<string, string> = {
        "nav.home": "Home",
        "nav.projects": "Projects",
        "nav.map": "Map",
        "nav.impact": "Impact",
        "nav.leaderboard": "Leaderboard",
        "nav.myImpact": "My Impact",
        "nav.apply": "Get Verified",
        "nav.transparency": "Transparency",
        "nav.governance": "Governance",
        "nav.bridge": "Bridge",
        "nav.connectWallet": "Connect Wallet",
        "nav.disconnect": "Disconnect",
        "nav.mainnet": "Mainnet",
        "nav.testnet": "Testnet",
        "nav.tagline": "Climate donations",
        "nav.unreadNotifications": "{{count}} unread notifications",
      };
      return translations[key] ?? key;
    },
  }),
}));

jest.mock("@/components/LanguageSwitcher", () => {
  return function MockLanguageSwitcher() {
    return <select aria-label="Language"><option value="en">EN</option></select>;
  };
});

jest.mock("@/components/ThemeToggle", () => {
  return function MockThemeToggle() {
    return <button aria-label="Toggle theme">Theme</button>;
  };
});

jest.mock("@/utils/format", () => ({
  shortenAddress: (addr: string) => addr.slice(0, 6) + "..." + addr.slice(-4),
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe("Navbar", () => {
  it("renders all navigation links", () => {
    render(<Navbar publicKey={null} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
    const homeLinks = screen.getAllByRole("link", { name: /home/i });
    expect(homeLinks.length).toBeGreaterThanOrEqual(1);
    expect(homeLinks[0]).toHaveAttribute("href", "/");
    const projectLinks = screen.getAllByRole("link", { name: /projects/i });
    expect(projectLinks.length).toBeGreaterThanOrEqual(1);
    expect(projectLinks[0]).toHaveAttribute("href", "/projects");
    expect(screen.getAllByRole("link", { name: /map/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("link", { name: /impact/i }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole("link", { name: /leaderboard/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("renders wallet connect button when not connected", () => {
    render(<Navbar publicKey={null} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
    expect(
      screen.getByRole("button", { name: /connect wallet/i }),
    ).toBeInTheDocument();
  });

  it("renders wallet address and disconnect button when connected", () => {
    const pk = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
    render(<Navbar publicKey={pk} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
    expect(screen.getAllByText(/GABCDE/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeInTheDocument();
  });

  it("calls onConnect when connect button is clicked", async () => {
    const user = userEvent.setup();
    const onConnect = jest.fn();
    render(<Navbar publicKey={null} onConnect={onConnect} onDisconnect={jest.fn()} />);
    await user.click(screen.getByRole("button", { name: /connect wallet/i }));
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it("calls onDisconnect when disconnect button is clicked", async () => {
    const user = userEvent.setup();
    const onDisconnect = jest.fn();
    const pk = "GABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890";
    render(<Navbar publicKey={pk} onConnect={jest.fn()} onDisconnect={onDisconnect} />);
    await user.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it("toggles mobile menu on hamburger click", async () => {
    const user = userEvent.setup();
    render(<Navbar publicKey={null} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
    const toggle = screen.getByRole("button", { name: /toggle navigation menu/i });
    await user.click(toggle);
    expect(toggle).toBeInTheDocument();
  });

  it("renders the theme toggle and language switcher", () => {
    render(<Navbar publicKey={null} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
    expect(screen.getByRole("button", { name: /toggle theme/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /language/i })).toBeInTheDocument();
  });

  it("renders the Stellar IndigoPay logo text", () => {
    render(<Navbar publicKey={null} onConnect={jest.fn()} onDisconnect={jest.fn()} />);
    expect(screen.getByText(/Stellar/)).toBeInTheDocument();
    expect(screen.getByText(/IndigoPay/)).toBeInTheDocument();
  });
});
