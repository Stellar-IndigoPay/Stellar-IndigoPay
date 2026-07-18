/**
 * __tests__/SkipToContent.test.tsx
 *
 * Unit tests for the SkipToContent link. Validates WCAG 2.4.1 Bypass Blocks
 * behaviour: the link is present, focusable, and announces "Skip to main
 * content" before the rest of the page.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import SkipToContent from "../SkipToContent";

describe("SkipToContent", () => {
  it("renders a link targeting the main-content landmark", () => {
    render(<SkipToContent />);
    const link = screen.getByRole("link", { name: /skip to main content/i });
    expect(link).toHaveAttribute("href", "#main-content");
  });

  it("is visually hidden by default but becomes visible on focus", () => {
    render(<SkipToContent />);
    const link = screen.getByRole("link", { name: /skip to main content/i });
    expect(link.className).toContain("sr-only");
    expect(link.className).toContain("focus:not-sr-only");
  });

  it("is the first focusable element in the tab order", async () => {
    const user = userEvent.setup();
    render(
      <>
        <SkipToContent />
        <button>Other</button>
      </>,
    );
    await user.tab();
    expect(
      screen.getByRole("link", { name: /skip to main content/i }),
    ).toHaveFocus();
  });
});
