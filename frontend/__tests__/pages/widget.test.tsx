/**
 * __tests__/pages/widget.test.tsx
 *
 * Unit tests for the embeddable donation widget page.
 * Tests: project rendering, postMessage communication, ResizeObserver,
 * theme CSS variables, loading/error states, and wallet connect flow.
 */

import React from "react";
import { render, screen, waitFor, act } from "@testing-library/react";
import "@testing-library/jest-dom";

// ── Mocks ────────────────────────────────────────────────────────────────

const mockFetchProject = jest.fn();
jest.mock("@/lib/api", () => ({
  fetchProject: (...args: unknown[]) => mockFetchProject(...args),
}));

// Mock next/router
const mockQuery: Record<string, string> = {};
const mockRouter = {
  query: mockQuery,
  isReady: true,
  push: jest.fn(),
  pathname: "/widget/test-project-id",
};

jest.mock("next/router", () => ({
  useRouter: () => mockRouter,
}));

// Mock next/head
jest.mock("next/head", () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock DonateForm
jest.mock("@/components/DonateForm", () => ({
  __esModule: true,
  default: ({ onSuccess, publicKey }: { project: unknown; publicKey: string; onSuccess?: () => void }) => (
    <div data-testid="donate-form">
      <span data-testid="donate-public-key">{publicKey}</span>
      <button data-testid="trigger-donate-success" onClick={onSuccess}>
        Complete Donation
      </button>
    </div>
  ),
}));

// Mock WalletConnect
jest.mock("@/components/WalletConnect", () => ({
  __esModule: true,
  default: ({ onConnect }: { onConnect: (pk: string) => void }) => (
    <button data-testid="wallet-connect" onClick={() => onConnect("GDUMMYWALLETADDRESS12345678901234567890123456789012")}>
      Connect Wallet
    </button>
  ),
}));

// ── Helpers ──────────────────────────────────────────────────────────────

const validProject = {
  id: "test-project-id",
  name: "Amazon Reforestation",
  description: "Planting trees in the Amazon",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABC123",
  goalXLM: "10000",
  raisedXLM: "5000",
  donorCount: 147,
  co2OffsetKg: 24500,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: ["reforestation"],
  averageRating: 4.5,
  ratingCount: 12,
  milestones: [],
  campaigns: [],
  co2_per_xlm: 2.5,
};

function setupQuery(params: Record<string, string>) {
  Object.keys(mockQuery).forEach((k) => delete mockQuery[k]);
  Object.assign(mockQuery, { projectId: "test-project-id", ...params });
  mockRouter.isReady = true;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("Widget Page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchProject.mockResolvedValue(validProject);
    setupQuery({});
  });

  // -----------------------------------------------------------------------
  // Rendering
  // -----------------------------------------------------------------------

  test("renders project name after loading", async () => {
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("Amazon Reforestation")).toBeInTheDocument();
    });
  });

  test("renders project stats (donors, CO2) after loading", async () => {
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("147")).toBeInTheDocument();
    });
  });

  test("renders wallet connect button when not connected", async () => {
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-connect")).toBeInTheDocument();
    });
  });

  test("renders donate form after wallet connects", async () => {
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-connect")).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByTestId("wallet-connect").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("donate-form")).toBeInTheDocument();
      expect(screen.getByTestId("donate-public-key").textContent).toBe(
        "GDUMMYWALLETADDRESS12345678901234567890123456789012"
      );
    });
  });

  // -----------------------------------------------------------------------
  // Error / Empty states
  // -----------------------------------------------------------------------

  test("shows error message when project fetch fails", async () => {
    mockFetchProject.mockRejectedValue({ response: { status: 404 } });
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("Project not found")).toBeInTheDocument();
    });
  });

  // -----------------------------------------------------------------------
  // postMessage
  // -----------------------------------------------------------------------

  test("sends resize postMessage after loading", async () => {
    const postMessageSpy = jest.spyOn(window.parent, "postMessage");
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("Amazon Reforestation")).toBeInTheDocument();
    });

    // ResizeObserver fires on mount
    const resizeCalls = postMessageSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "indigopay:resize"
    );
    expect(resizeCalls.length).toBeGreaterThanOrEqual(1);
    expect(resizeCalls[0][0]).toMatchObject({
      type: "indigopay:resize",
      height: expect.any(Number),
    });

    postMessageSpy.mockRestore();
  });

  test("sends donation-complete postMessage when donation succeeds", async () => {
    const postMessageSpy = jest.spyOn(window.parent, "postMessage");
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByTestId("wallet-connect")).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByTestId("wallet-connect").click();
    });

    await waitFor(() => {
      expect(screen.getByTestId("donate-form")).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByTestId("trigger-donate-success").click();
    });

    const donationCalls = postMessageSpy.mock.calls.filter(
      (call: unknown[]) => (call[0] as { type?: string })?.type === "indigopay:donation-complete"
    );
    expect(donationCalls.length).toBe(1);
    expect(donationCalls[0][0]).toMatchObject({
      type: "indigopay:donation-complete",
      projectId: "test-project-id",
    });

    postMessageSpy.mockRestore();
  });

  // -----------------------------------------------------------------------
  // Theme (CSS custom properties)
  // -----------------------------------------------------------------------

  test("applies default theme CSS variables", async () => {
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    const { container } = render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("Amazon Reforestation")).toBeInTheDocument();
    });

    // The first child inside the container is the <meta> from <Head>.
    // The widget div with the CSS custom properties is the second child.
    const rootDiv = container.children[1] as HTMLElement;
    expect(rootDiv.style.getPropertyValue("--igp-primary")).toBe("#4F46E5");
    expect(rootDiv.style.getPropertyValue("--igp-text")).toBe("#0F172A");
    expect(rootDiv.style.getPropertyValue("--igp-bg")).toBe("#FFFFFF");
    expect(rootDiv.style.getPropertyValue("--igp-radius")).toBe("12px");
  });

  test("applies custom theme from URL query params", async () => {
    setupQuery({
      primary: "#227239",
      text: "#1a2e1a",
      background: "#f0f7f0",
      radius: "16",
    });

    const WidgetPage = require("@/pages/widget/[projectId]").default;
    const { container } = render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("Amazon Reforestation")).toBeInTheDocument();
    });

    const rootDiv = container.children[1] as HTMLElement;
    expect(rootDiv.style.getPropertyValue("--igp-primary")).toBe("#227239");
    expect(rootDiv.style.getPropertyValue("--igp-text")).toBe("#1a2e1a");
    expect(rootDiv.style.getPropertyValue("--igp-bg")).toBe("#f0f7f0");
    expect(rootDiv.style.getPropertyValue("--igp-radius")).toBe("16px");
  });

  test("updates theme when parent sends indigopay:set-theme message", async () => {
    const WidgetPage = require("@/pages/widget/[projectId]").default;
    const { container } = render(<WidgetPage />);

    await waitFor(() => {
      expect(screen.getByText("Amazon Reforestation")).toBeInTheDocument();
    });

    await act(async () => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "indigopay:set-theme",
            primary: "#ff0000",
            text: "#000000",
          },
        })
      );
    });

    const rootDiv = container.children[1] as HTMLElement;
    expect(rootDiv.style.getPropertyValue("--igp-primary")).toBe("#ff0000");
  });
});
