/**
 * components/__tests__/StalePriceIndicator.test.tsx
 *
 * Unit tests for the StalePriceIndicator component. Mocks usePriceContext
 * so we can control isStale / isDegraded / priceAgeMs in isolation.
 *
 * @jest-environment jsdom
 */
import { render, screen } from "@testing-library/react";
import StalePriceIndicator from "@/components/StalePriceIndicator";

jest.mock("@/lib/priceContext", () => ({
  usePriceContext: jest.fn(),
}));
import { usePriceContext } from "@/lib/priceContext";
const mockUsePriceContext = usePriceContext as jest.Mock;

describe("StalePriceIndicator", () => {
  it("renders nothing when the price is fresh", () => {
    mockUsePriceContext.mockReturnValue({
      isStale: false,
      isDegraded: false,
      priceAgeMs: 10_000,
    });
    const { container } = render(<StalePriceIndicator />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the amber stale chip when isStale is true", () => {
    mockUsePriceContext.mockReturnValue({
      isStale: true,
      isDegraded: false,
      priceAgeMs: 6 * 60_000, // 6 minutes
    });
    render(<StalePriceIndicator />);
    const el = screen.getByTestId("price-indicator-stale");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("role", "status");
    // Should include age label
    expect(el.textContent).toMatch(/6m ago/);
  });

  it("renders the red degraded chip when isDegraded is true", () => {
    mockUsePriceContext.mockReturnValue({
      isStale: true,
      isDegraded: true,
      priceAgeMs: 15 * 60_000,
    });
    render(<StalePriceIndicator />);
    const el = screen.getByTestId("price-indicator-degraded");
    expect(el).toBeInTheDocument();
    expect(el).toHaveAttribute("role", "status");
    expect(el.textContent).toMatch(/unavailable/i);
  });

  it("degraded chip takes priority over stale chip", () => {
    mockUsePriceContext.mockReturnValue({
      isStale: true,
      isDegraded: true,
      priceAgeMs: 20 * 60_000,
    });
    render(<StalePriceIndicator />);
    expect(screen.queryByTestId("price-indicator-stale")).toBeNull();
    expect(screen.getByTestId("price-indicator-degraded")).toBeInTheDocument();
  });

  it("renders stale chip without age label when priceAgeMs is null", () => {
    mockUsePriceContext.mockReturnValue({
      isStale: true,
      isDegraded: false,
      priceAgeMs: null,
    });
    render(<StalePriceIndicator />);
    const el = screen.getByTestId("price-indicator-stale");
    expect(el.textContent).toMatch(/may be outdated/i);
  });

  it("applies the className prop to the outer element", () => {
    mockUsePriceContext.mockReturnValue({
      isStale: true,
      isDegraded: false,
      priceAgeMs: 7 * 60_000,
    });
    render(<StalePriceIndicator className="custom-class" />);
    const el = screen.getByTestId("price-indicator-stale");
    expect(el.className).toContain("custom-class");
  });
});
