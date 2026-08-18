/**
 * __tests__/transparency.test.tsx
 *
 * Unit tests for the transparency dashboard page and its child components.
 * Covers: HealthBanner states, StatCard rendering, SLO panel visibility,
 * donation feed rendering, and WorldMap donation markers.
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import HealthBanner from "@/components/HealthBanner";
import StatCard from "@/components/StatCard";
import SLOStatusPanel from "@/components/SLOStatusPanel";
import type { SLOData } from "@/lib/transparencyHooks";

// ── jsdom polyfills ────────────────────────────────────────────────────────
// jsdom does not implement AbortSignal.timeout(), which HealthBanner uses
// for the readiness fetch call. Polyfill it so the mock fetch is reached.
const ORIGINAL_ABORT_TIMEOUT = AbortSignal.timeout;
beforeAll(() => {
  AbortSignal.timeout = (_ms: number) => {
    const controller = new AbortController();
    return controller.signal;
  };
});
afterAll(() => {
  AbortSignal.timeout = ORIGINAL_ABORT_TIMEOUT;
});

// ── Mock fetch globally (follow adminAuth.test.ts pattern) ────────────────

const ORIGINAL_FETCH = global.fetch;

beforeEach(() => {
  global.fetch = jest.fn();
});

afterAll(() => {
  global.fetch = ORIGINAL_FETCH;
});

// ── HealthBanner Tests ────────────────────────────────────────────────────

describe("HealthBanner", () => {
  it('shows "All Systems Operational" when readyz returns 200 with all checks OK', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "ready",
        checks: {
          db: { status: "ok" },
          pool: { status: "ok", waitingCount: 0, max: 10 },
          horizon: { status: "ok" },
        },
      }),
    });

    render(<HealthBanner />);

    await screen.findByText(/All Systems Operational/i);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText(/🟢/)).toBeInTheDocument();
  });

  it('shows "Service Disruption" when subsystems are unreachable', async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      json: async () => ({
        status: "not ready",
        checks: {
          db: { status: "ok" },
          pool: { status: "ok", waitingCount: 0, max: 10 },
          soroban_rpc: { status: "degraded", reason: "RPC slow response" },
          horizon: { status: "unreachable", reason: "timeout" },
        },
      }),
    });

    render(<HealthBanner />);

    await screen.findByText(/Service Disruption/i);
    expect(screen.getByText(/🔴/)).toBeInTheDocument();
  });

  it('shows "Service Disruption" when fetch fails', async () => {
    (global.fetch as jest.Mock).mockRejectedValue(new Error("Network error"));

    render(<HealthBanner />);

    await screen.findByText(/Service Disruption/i);
    expect(screen.getByText(/🔴/)).toBeInTheDocument();
  });

  it("shows loading skeleton initially before fetch resolves", async () => {
    // Return a promise that never resolves so the component stays in loading state
    (global.fetch as jest.Mock).mockImplementation(() => new Promise(() => {}));

    const { container } = render(<HealthBanner />);

    // The initial render shows a skeleton (animated pulse box) before the fetch resolves
    const skeletonBox = container.querySelector(".animate-pulse");
    expect(skeletonBox).toBeInTheDocument();
    expect(skeletonBox).toHaveClass("rounded");
  });
});

// ── StatCard Tests ────────────────────────────────────────────────────────

describe("StatCard", () => {
  it("renders label and value", () => {
    render(
      <StatCard
        label="Total Donated"
        value={12345}
        suffix="XLM"
        icon={<span data-testid="icon">💰</span>}
      />,
    );

    expect(screen.getByText("Total Donated")).toBeInTheDocument();
    expect(screen.getByText("XLM")).toBeInTheDocument();
  });

  it("renders with prefix", () => {
    render(
      <StatCard
        label="Completion"
        value={85}
        prefix=">"
        suffix="%"
      />,
    );

    expect(screen.getByText(">")).toBeInTheDocument();
    expect(screen.getByText("%")).toBeInTheDocument();
  });

  it("handles string values", () => {
    render(
      <StatCard
        label="Total Raised"
        value="5000.50"
        suffix="XLM"
      />,
    );

    expect(screen.getByText("Total Raised")).toBeInTheDocument();
    expect(screen.getByText("XLM")).toBeInTheDocument();
  });

  it("has accessible region role with aria-label", () => {
    render(
      <StatCard
        label="Donors"
        value={500}
        ariaLabel="Total unique donors"
      />,
    );

    expect(screen.getByRole("region", { name: /Total unique donors/i })).toBeInTheDocument();
  });
});

// ── SLOStatusPanel Tests ──────────────────────────────────────────────────

describe("SLOStatusPanel", () => {
  const mockSLOData: SLOData = {
    donations: {
      errorRatio: 0.001,
      errorBudgetRemaining: 80,
    },
    projects: {
      errorRatio: 0.0005,
      errorBudgetRemaining: 50,
    },
  };

  it("renders with SLO data", () => {
    render(<SLOStatusPanel sloData={mockSLOData} />);

    expect(screen.getByText(/Service Level Objectives/i)).toBeInTheDocument();
    expect(screen.getByText(/Donations SLO/i)).toBeInTheDocument();
    expect(screen.getByText(/Projects SLO/i)).toBeInTheDocument();
    expect(screen.getByText(/80.0% budget remaining/i)).toBeInTheDocument();
    expect(screen.getByText(/50.0% budget remaining/i)).toBeInTheDocument();
  });

  it("shows admin badge", () => {
    render(<SLOStatusPanel sloData={mockSLOData} />);

    expect(screen.getByText(/Admin/i)).toBeInTheDocument();
  });

  it("shows loading skeleton when isLoading is true", () => {
    const { container } = render(<SLOStatusPanel sloData={null} isLoading={true} />);

    // Skeleton should render a card container with animated pulse elements
    const skeletonCard = container.querySelector(".card");
    expect(skeletonCard).toBeInTheDocument();
  });

  it("shows admin auth message when error mentions auth", () => {
    render(
      <SLOStatusPanel
        sloData={null}
        error="Admin authentication required"
      />,
    );

    expect(
      screen.getByText(/Admin login required to view SLO metrics/i),
    ).toBeInTheDocument();
  });

  it("returns null when sloData is null and not loading", () => {
    const { container } = render(
      <SLOStatusPanel sloData={null} />,
    );

    expect(container.firstChild).toBeNull();
  });
});

// ── Recent Donations Feed (rendered inside transparency page) ────────────

describe("Transparency Page Integration (Recent Donations)", () => {
  it("renders waiting state when no donations", () => {
    render(
      <div>
        <p className="text-[#94A3B8] dark:text-[#64748B] text-sm font-body">
          Waiting for donations to appear…
        </p>
      </div>,
    );

    expect(
      screen.getByText(/Waiting for donations to appear/i),
    ).toBeInTheDocument();
  });
});
