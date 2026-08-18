/**
 * __tests__/components/PageTransition.test.tsx
 *
 * Verifies that the page transition respects `prefers-reduced-motion`:
 *  - when reduced motion is requested, the wrapper still renders its
 *    children, and Framer Motion reports a zero-duration / no-offset
 *    variant (no translateY transform is applied to the element).
 *  - when motion is allowed, the wrapper is present and focusable
 *    (tabindex) so post-navigation focus can move to it.
 */
import { render, screen } from "@testing-library/react";
import PageTransition from "@/components/PageTransition";

// Default: motion allowed.
let reducedMotion = false;

jest.mock("framer-motion", () => {
  const actual = jest.requireActual("framer-motion");
  return {
    ...actual,
    useReducedMotion: () => reducedMotion,
  };
});

describe("PageTransition", () => {
  beforeEach(() => {
    reducedMotion = false;
  });

  it("renders its children", () => {
    render(
      <PageTransition>
        <p>Project dashboard</p>
      </PageTransition>,
    );
    expect(screen.getByText("Project dashboard")).toBeInTheDocument();
  });

  it("does not apply a vertical transform when reduced motion is preferred", () => {
    reducedMotion = true;
    const { container } = render(
      <PageTransition>
        <p>Reduced motion content</p>
      </PageTransition>,
    );
    const motionDiv = container.firstChild as HTMLElement;
    // Framer Motion sets a no-op transform (none) rather than a
    // translateY when the reduced variant is used.
    expect(motionDiv.style.transform).not.toMatch(/translateY/);
  });

  it("exposes a programmatic focus target for keyboard navigation", () => {
    const { container } = render(
      <PageTransition>
        <p>Focusable content</p>
      </PageTransition>,
    );
    const motionDiv = container.firstChild as HTMLElement;
    expect(motionDiv.getAttribute("tabindex")).toBe("-1");
  });
});
