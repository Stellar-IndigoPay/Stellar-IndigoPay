/**
 * components/__tests__/EmptyState.test.tsx
 *
 * Unit + accessibility tests for the shared EmptyState component.
 */
import { render, screen } from "@testing-library/react";
import { axe } from "jest-axe";
import EmptyState from "../EmptyState";

describe("EmptyState", () => {
  it("renders the title", () => {
    render(<EmptyState title="No donations yet" />);
    expect(
      screen.getByRole("heading", { name: "No donations yet" }),
    ).toBeInTheDocument();
  });

  it("renders the description when provided", () => {
    render(
      <EmptyState
        title="No projects match your filters"
        description="Try adjusting your search or filters."
      />,
    );
    expect(
      screen.getByText("Try adjusting your search or filters."),
    ).toBeInTheDocument();
  });

  it("omits the description paragraph when not provided", () => {
    render(<EmptyState title="No saved projects yet" />);
    expect(
      screen.queryByText("Try adjusting your search or filters."),
    ).not.toBeInTheDocument();
  });

  it("renders the action CTA when provided", () => {
    render(
      <EmptyState
        title="No donations yet"
        action={<button>Browse Projects</button>}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Browse Projects" }),
    ).toBeInTheDocument();
  });

  it("uses the default icon for the empty variant", () => {
    render(<EmptyState title="No saved projects yet" variant="empty" />);
    expect(screen.getByTestId("empty-state")).toHaveTextContent("🌱");
  });

  it("uses the default icon for the search variant", () => {
    render(
      <EmptyState
        title="No projects match your filters"
        variant="search"
      />,
    );
    expect(screen.getByTestId("empty-state")).toHaveTextContent("🔍");
  });

  it("uses the default icon for the error variant", () => {
    render(<EmptyState title="Couldn't load donations" variant="error" />);
    expect(screen.getByTestId("empty-state")).toHaveTextContent("⚠️");
  });

  it("uses a custom icon override when supplied", () => {
    render(
      <EmptyState
        title="No results"
        icon={<span data-testid="custom-icon">custom</span>}
      />,
    );
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
  });

  it("exposes the selected variant via data-variant for styling/testing hooks", () => {
    render(<EmptyState title="No results" variant="search" />);
    expect(screen.getByTestId("empty-state")).toHaveAttribute(
      "data-variant",
      "search",
    );
  });

  it("renders the title as an h2 by default", () => {
    render(<EmptyState title="No donations yet" />);
    const heading = screen.getByRole("heading", { name: "No donations yet" });
    expect(heading.tagName).toBe("H2");
  });

  it("renders the title as an h3 when headingLevel is overridden", () => {
    render(<EmptyState title="No donations yet" headingLevel="h3" />);
    const heading = screen.getByRole("heading", { name: "No donations yet" });
    expect(heading.tagName).toBe("H3");
  });

  it("has no axe violations with title only", async () => {
    const { container } = render(<EmptyState title="No donations yet" />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("has no axe violations with description and action", async () => {
    const { container } = render(
      <EmptyState
        title="No projects match your filters"
        description="Try adjusting your search or filters."
        action={<button>Clear filters</button>}
      />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
