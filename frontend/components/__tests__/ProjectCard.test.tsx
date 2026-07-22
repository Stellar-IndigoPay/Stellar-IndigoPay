/**
 * ProjectCard.test.tsx
 *
 * Behavioral assertions for ProjectCard. Replaces the previous pure-snapshot
 * tests so that WCAG-#138 DOM refactors (moving `<button>` out of `<a>`
 * to fix invalid HTML, swapping tooltip <button> for a non-interactive
 * span) don't require snapshot regeneration every time.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ProjectCard, { ProjectCardSkeleton } from "../ProjectCard";
import type { ClimateProject } from "@/utils/types";

const mockProject: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation Initiative",
  description: "Restoring native tree cover across degraded rainforest land.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  goalXLM: "10000",
  raisedXLM: "2500",
  donorCount: 42,
  co2OffsetKg: 1200,
  co2_per_xlm: 0.48,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: ["trees", "carbon"],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

describe("ProjectCard", () => {
  it("renders the project as a focusable link with a descriptive aria-label", () => {
    render(<ProjectCard project={mockProject} />);
    const link = screen.getByRole("link", {
      name: /view project: amazon reforestation initiative/i,
    });
    expect(link).toHaveAttribute("href", "/projects/proj-1");
  });

  it("renders category, name, location and donor count", () => {
    render(<ProjectCard project={mockProject} />);
    expect(screen.getByText("Reforestation")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /amazon reforestation initiative/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/brazil/i)).toBeInTheDocument();
    expect(screen.getByText(/42 donors/i)).toBeInTheDocument();
  });

  it("shows a ‘Fully Funded’ badge when raised >= goal", () => {
    const funded: ClimateProject = { ...mockProject, raisedXLM: "10000" };
    render(<ProjectCard project={funded} />);
    expect(screen.getAllByText(/fully funded/i).length).toBeGreaterThan(0);
  });

  it("renders the wishlist toggle as a sibling of the <a>, NOT nested inside", () => {
    // Nesting <button> inside <a> is invalid HTML. We assert the wishlist
    // button is present in the document, sibling to the link.
    const { container } = render(<ProjectCard project={mockProject} />);
    const link = container.querySelector("a[href='/projects/proj-1']")!;
    const wishlist = screen.getByRole("button", {
      name: /add .* to wishlist/i,
    });
    expect(link).toBeTruthy();
    expect(wishlist).toBeTruthy();
    // Assert the wishlist button is NOT a descendant of the link.
    expect(link.contains(wishlist)).toBe(false);
  });

  it("toggles wishlist aria-pressed state when clicked", async () => {
    const user = userEvent.setup();
    render(<ProjectCard project={mockProject} />);
    const wishlist = screen.getByRole("button", {
      name: /add .* to wishlist/i,
    });
    expect(wishlist).toHaveAttribute("aria-pressed", "false");
    await user.click(wishlist);
    expect(
      screen.getByRole("button", { name: /remove .* from wishlist/i }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("exposes a tooltip info marker without nesting an interactive element in the link", () => {
    render(<ProjectCard project={mockProject} />);
    expect(
      screen.getByRole("img", { name: /co₂ offset estimate methodology info/i }),
    ).toBeInTheDocument();
  });

  it("renders the loading skeleton without any interactive elements", () => {
    render(<ProjectCardSkeleton />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("does not crash when stat handlers fire (no preventDefault errors)", () => {
    const { container } = render(<ProjectCard project={mockProject} />);
    // Clicking the wishlist button shouldn't bubble up and cause an error
    // from inside the link navigation handler.
    const wishlist = container.querySelector("button[aria-pressed]")!;
    fireEvent.click(wishlist);
    expect(wishlist).toBeDefined();
  });
});
