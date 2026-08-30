/**
 * components/__tests__/PriceStaleIndicator.test.tsx
 *
 * Unit tests for the PriceStaleIndicator component.
 *
 * @jest-environment jsdom
 */
import React from "react";
import { render, screen } from "@testing-library/react";
import { PriceStaleIndicator } from "@/components/PriceStaleIndicator";

describe("PriceStaleIndicator", () => {
  it("renders nothing when price is fresh (isStale=false, isDegraded=false)", () => {
    const { container } = render(
      <PriceStaleIndicator isStale={false} isDegraded={false} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders an indicator when price is stale", () => {
    render(<PriceStaleIndicator isStale={true} isDegraded={false} />);
    expect(screen.getByTestId("price-stale-indicator")).toBeInTheDocument();
  });

  it("renders an indicator when price is degraded", () => {
    render(<PriceStaleIndicator isStale={false} isDegraded={true} />);
    expect(screen.getByTestId("price-stale-indicator")).toBeInTheDocument();
  });

  it("shows 'Price unavailable' aria-label when degraded", () => {
    render(<PriceStaleIndicator isStale={false} isDegraded={true} />);
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Price unavailable");
  });

  it("shows age in minutes when priceAgeMs < 60 minutes", () => {
    const fiveMinutes = 5 * 60_000;
    render(
      <PriceStaleIndicator
        isStale={true}
        isDegraded={false}
        priceAgeMs={fiveMinutes}
      />,
    );
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Price is 5 min old");
  });

  it("shows age in hours when priceAgeMs >= 60 minutes", () => {
    const twoHours = 2 * 60 * 60_000;
    render(
      <PriceStaleIndicator
        isStale={true}
        isDegraded={false}
        priceAgeMs={twoHours}
      />,
    );
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Price is 2 hr old");
  });

  it("shows generic 'may be outdated' label when stale but priceAgeMs is null", () => {
    render(
      <PriceStaleIndicator isStale={true} isDegraded={false} priceAgeMs={null} />,
    );
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Price may be outdated");
  });

  it("applies orange color class when degraded", () => {
    render(<PriceStaleIndicator isStale={false} isDegraded={true} />);
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator.className).toMatch(/orange/);
  });

  it("applies amber color class when stale (not degraded)", () => {
    render(<PriceStaleIndicator isStale={true} isDegraded={false} />);
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator.className).toMatch(/amber/);
  });

  it("applies custom className prop", () => {
    render(
      <PriceStaleIndicator
        isStale={true}
        isDegraded={false}
        className="ml-1"
      />,
    );
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator.className).toContain("ml-1");
  });

  it("degraded label takes priority over stale age label", () => {
    render(
      <PriceStaleIndicator
        isStale={true}
        isDegraded={true}
        priceAgeMs={10 * 60_000}
      />,
    );
    const indicator = screen.getByTestId("price-stale-indicator");
    expect(indicator).toHaveAttribute("aria-label", "Price unavailable");
  });
});
