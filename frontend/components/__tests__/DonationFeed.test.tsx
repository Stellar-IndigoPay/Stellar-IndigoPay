/**
 * __tests__/DonationFeed.test.tsx
 *
 * Unit tests for the virtualized donation feed (GrantFox #1130 / #1025):
 *   - only a bounded window of rows is rendered regardless of donation count
 *   - `aria-setsize`/`aria-posinset` announce the true count to screen readers
 *   - scrolling near the bottom loads the next (older) page via the cursor API
 *   - a real-time donation prepended while scrolled keeps the viewport anchored
 *   - a real-time donation while pinned at the top leaves the user at the top
 *
 * `@tanstack/react-virtual` needs real element geometry, so we fake layout:
 *   - the scroll container (role="list") reports 400px tall
 *   - every row (role="listitem") reports 96px tall
 *   - `Element#scrollTo` is polyfilled (jsdom does not implement it)
 */
import { render, screen, act, waitFor } from "@testing-library/react";

import { fetchProjectDonations } from "@/lib/api";
import { streamProjectPayments } from "@/lib/stellar";
import type { Donation } from "@/utils/types";

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock("@/lib/api", () => ({
  fetchProjectDonations: jest.fn(),
}));

jest.mock("@/lib/stellar", () => ({
  streamProjectPayments: jest.fn(),
  explorerUrl: (hash: string) => `https://stellar.expert/tx/${hash}`,
}));

// Component import must come AFTER the mocks so jest.mock applies.
// eslint-disable-next-line import/first
import DonationFeed from "../DonationFeed";

const mockFetchProjectDonations = fetchProjectDonations as jest.MockedFunction<
  typeof fetchProjectDonations
>;
const mockStreamProjectPayments = streamProjectPayments as jest.MockedFunction<
  typeof streamProjectPayments
>;

// ── Layout fakes ───────────────────────────────────────────────────────────────

const ROW_HEIGHT = 96;
const VIEWPORT_HEIGHT = 400;

beforeAll(() => {
  // jsdom lacks Element.prototype.scrollTo; the virtualizer calls it when we
  // re-anchor the viewport.
  if (typeof Element.prototype.scrollTo !== "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    // Note: do NOT dispatch a `scroll` event here — the virtualizer calls
    // `scrollTo` from inside a layout effect, and a synchronous event would
    // make it `flushSync` mid-render. Real browsers fire `scroll` asynchronously.
    (Element.prototype as any).scrollTo = function (
      opts?: { top?: number; left?: number } | number,
    ) {
      const top = typeof opts === "object" ? (opts?.top ?? 0) : (opts ?? 0);
      this.scrollTop = top;
    };
  }

  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      // The scroll container carries role="list"; everything else is a row.
      if (this.getAttribute?.("role") === "list") return VIEWPORT_HEIGHT;
      return ROW_HEIGHT;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get() {
      return 600;
    },
  });
  // The virtualizer clamps programmatic scroll offsets to
  // `scrollHeight - clientHeight`; give the container enough real scroll room.
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
    configurable: true,
    get() {
      if (this.getAttribute?.("role") === "list") {
        const rows = this.querySelectorAll('[role="listitem"]').length;
        return Math.max(rows, 1) * ROW_HEIGHT;
      }
      return 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this.getAttribute?.("role") === "list") return VIEWPORT_HEIGHT;
      return 0;
    },
  });
});

afterAll(() => {
  delete (Element.prototype as Partial<Element>).scrollTo;
});

// ── Fixtures ──────────────────────────────────────────────────────────────────

const WALLET = "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST";

function makeDonation(id: string, overrides: Partial<Donation> = {}): Donation {
  return {
    id,
    projectId: "proj-1",
    donorAddress: "GCEZWKW744OREGLTR6Q6ZYITK5GSBVC3XRONSIJSBTRSCGNFAVSBXP33",
    amountXLM: "10",
    amount: "10",
    currency: "XLM",
    transactionHash: `tx-${id}`,
    createdAt: "2026-07-17T12:00:00Z",
    ...overrides,
  };
}

function page(donations: Donation[], nextCursor: string | null) {
  return { donations, nextCursor };
}

function resolveInitialPage(items: Donation[], cursor: string | null = null) {
  mockFetchProjectDonations.mockResolvedValueOnce(page(items, cursor));
}

async function renderLoadedFeed() {
  render(<DonationFeed projectId="proj-1" />);
  await waitFor(() =>
    expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0),
  );
  return screen.getByTestId("donation-feed-scroll");
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("DonationFeed (virtualized)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders only a bounded window of DOM nodes for a large list", async () => {
    const many = Array.from({ length: 500 }, (_, i) => makeDonation(`don-${i}`));
    resolveInitialPage(many);

    render(<DonationFeed projectId="proj-1" />);

    await waitFor(() =>
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0),
    );

    const rendered = screen.getAllByRole("listitem").length;
    // Viewport shows ~4 rows with ~8 rows of overscan on each side — never
    // anywhere near the full 500.
    expect(rendered).toBeLessThan(50);
    expect(rendered).toBeLessThan(many.length);

    // Screen readers still learn the true list size.
    const first = screen.getAllByRole("listitem")[0];
    expect(first).toHaveAttribute("aria-setsize", "500");
    expect(first).toHaveAttribute("aria-posinset", "1");
  });

  it("exposes the list semantics to assistive technology", async () => {
    resolveInitialPage([makeDonation("don-0"), makeDonation("don-1")]);

    render(<DonationFeed projectId="proj-1" />);
    await waitFor(() =>
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0),
    );

    const list = screen.getByRole("list", { name: /recent donations/i });
    expect(list).toBeInTheDocument();
    expect(list).toHaveAttribute("tabindex", "0");
  });

  it("loads the next older page when scrolled near the bottom", async () => {
    const firstPage = Array.from({ length: 10 }, (_, i) =>
      makeDonation(`don-${i}`),
    );
    const secondPage = Array.from({ length: 10 }, (_, i) =>
      makeDonation(`old-${i}`),
    );
    resolveInitialPage(firstPage, "cursor-page-2");
    mockFetchProjectDonations.mockResolvedValueOnce(page(secondPage, null));

    const scroller = await renderLoadedFeed();

    // 10 rows * 96px = 960px of virtual content in a 400px viewport.
    // Scrolling to 500px leaves 960 - 400 - 500 = 60px from the end, which is
    // within the 160px trigger threshold.
    act(() => {
      scroller.scrollTop = 500;
      scroller.dispatchEvent(new Event("scroll"));
    });

    await waitFor(() =>
      expect(mockFetchProjectDonations).toHaveBeenCalledWith(
        "proj-1",
        10,
        "cursor-page-2",
      ),
    );

    await waitFor(() =>
      expect(screen.getAllByRole("listitem").length).toBeGreaterThanOrEqual(
        firstPage.length,
      ),
    );
    expect(mockFetchProjectDonations).toHaveBeenCalledTimes(2);
  });

  it("keeps the viewport anchored when a new donation is prepended while scrolled", async () => {
    const items = Array.from({ length: 10 }, (_, i) => makeDonation(`don-${i}`));
    resolveInitialPage(items);
    mockStreamProjectPayments.mockReturnValue(() => {});

    render(<DonationFeed projectId="proj-1" walletAddress={WALLET} />);
    await waitFor(() =>
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0),
    );

    const scroller = screen.getByTestId("donation-feed-scroll");

    // Scroll to 300px: the first visible row is `don-3` (top edge at 288px).
    act(() => {
      scroller.scrollTop = 300;
      scroller.dispatchEvent(new Event("scroll"));
    });
    expect(scroller.scrollTop).toBe(300);

    // The SSE callback is the 2nd argument of streamProjectPayments.
    const handlePayment = mockStreamProjectPayments.mock.calls[0][1];

    act(() => {
      handlePayment({
        id: "don-live",
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "25",
        asset: "XLM",
        createdAt: "2026-07-17T12:01:00Z",
        transactionHash: "tx-live",
      });
    });

    // One row (96px) was prepended, so the anchored row shifts down by a row
    // to keep the same content in view.
    await waitFor(() => expect(scroller.scrollTop).toBe(396));
  });

  it("stays pinned to the top when a new donation arrives while at the top", async () => {
    const items = Array.from({ length: 10 }, (_, i) => makeDonation(`don-${i}`));
    resolveInitialPage(items);
    mockStreamProjectPayments.mockReturnValue(() => {});

    render(<DonationFeed projectId="proj-1" walletAddress={WALLET} />);
    await waitFor(() =>
      expect(screen.getAllByRole("listitem").length).toBeGreaterThan(0),
    );

    const handlePayment = mockStreamProjectPayments.mock.calls[0][1];
    act(() => {
      handlePayment({
        id: "don-live",
        from: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        amount: "25",
        asset: "XLM",
        createdAt: "2026-07-17T12:01:00Z",
        transactionHash: "tx-live",
      });
    });

    await waitFor(() =>
      expect(screen.getByText("25 XLM")).toBeInTheDocument(),
    );
    const scroller = screen.getByTestId("donation-feed-scroll");
    expect(scroller.scrollTop).toBe(0);
  });

  it("renders the empty state when there are no donations", async () => {
    resolveInitialPage([]);
    render(<DonationFeed projectId="proj-1" />);
    await waitFor(() =>
      expect(screen.getByText("No donations yet")).toBeInTheDocument(),
    );
  });
});
