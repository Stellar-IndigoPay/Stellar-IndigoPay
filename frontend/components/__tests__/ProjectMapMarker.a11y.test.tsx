/**
 * __tests__/ProjectMapMarker.a11y.test.tsx
 *
 * Accessibility tests for the per-project Leaflet marker. Asserts WCAG
 * 2.1.1 (Keyboard) and 4.1.2 (Name, Role, Value) by checking:
 *  - the marker icon is rendered as a keyboard-focusable <button>
 *  - the button has a descriptive aria-label including the project name
 *  - pressing Enter or Space opens the popup
 *  - other keys are no-ops
 *  - the project name is HTML-escaped before being embedded in attributes
 *  - jest-axe reports no violations on the rendered marker tree
 */
import { render, screen, fireEvent } from "@testing-library/react";
import { axe } from "jest-axe";
import type { ClimateProject } from "@/utils/types";

// ── Mock react-leaflet ─────────────────────────────────────────────────────────
//
// react-leaflet + Leaflet require a real map container and computed styles
// that jsdom cannot provide.  We replace it with a synchronous stub that:
//   - renders the divIcon HTML into a wrapper div
//   - forwards eventHandlers.keydown to the wrapper so keydown events bubble
//   - exposes a ref-compatible `openPopup` so the keyboard handler can call it
const mockOpenPopup = jest.fn();

jest.mock("react-leaflet", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = jest.requireActual("react");
  const Marker = React.forwardRef(
    (
      {
        children,
        icon,
        eventHandlers,
      }: {
        children?: React.ReactNode;
        icon: { options: { html: string } };
        eventHandlers?: {
          keydown?: (event: { originalEvent: KeyboardEvent }) => void;
        };
      },
      ref: React.Ref<{ openPopup: () => void }>,
    ) => {
      React.useImperativeHandle(ref, () => ({
        openPopup: mockOpenPopup,
      }));
      const html = icon.options.html;
      return (
        <div data-testid="project-marker">
          <div
            data-testid="marker-icon-wrapper"
            onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) =>
              eventHandlers?.keydown?.({ originalEvent: e.nativeEvent })
            }
            dangerouslySetInnerHTML={{ __html: html }}
          />
          {children}
        </div>
      );
    },
  );
  Marker.displayName = "LeafletMarkerStub";
  return {
    Marker,
    Popup: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popup">{children}</div>
    ),
  };
});

// Component import must come AFTER the mock so jest.mock applies.
import ProjectMapMarker from "../ProjectMapMarker";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const project: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation",
  description: "Restoring native tree cover across degraded rainforest.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
  goalXLM: "100",
  raisedXLM: "0",
  donorCount: 0,
  co2OffsetKg: 12,
  co2_per_xlm: 0.5,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProjectMapMarker accessibility", () => {
  beforeEach(() => {
    mockOpenPopup.mockClear();
  });

  it("renders a focusable button with role=button and aria-label including the project name", () => {
    render(<ProjectMapMarker project={project} position={[0, 0]} />);
    const button = screen.getByRole("button", {
      name: /view project: amazon reforestation/i,
    });
    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("tabindex", "0");
  });

  it("opens the popup when Enter is pressed on the marker", () => {
    render(<ProjectMapMarker project={project} position={[0, 0]} />);
    const wrapper = screen.getByTestId("marker-icon-wrapper");
    // Fire on the wrapper because that's where the eventHandlers.keydown
    // is attached in our mock — this mirrors what Leaflet does in
    // production (it attaches a single keydown listener on the marker
    // element and the keydown bubbles up from the focused <button>).
    fireEvent.keyDown(wrapper, { key: "Enter" });
    expect(mockOpenPopup).toHaveBeenCalledTimes(1);
  });

  it("opens the popup when Space is pressed on the marker", () => {
    render(<ProjectMapMarker project={project} position={[0, 0]} />);
    const wrapper = screen.getByTestId("marker-icon-wrapper");
    fireEvent.keyDown(wrapper, { key: " " });
    expect(mockOpenPopup).toHaveBeenCalledTimes(1);
  });

  it("does not open the popup for other keys", () => {
    render(<ProjectMapMarker project={project} position={[0, 0]} />);
    const wrapper = screen.getByTestId("marker-icon-wrapper");
    fireEvent.keyDown(wrapper, { key: "a" });
    fireEvent.keyDown(wrapper, { key: "Tab" });
    expect(mockOpenPopup).not.toHaveBeenCalled();
  });

  it("applies a unique aria-label per project", () => {
    const project2 = { ...project, id: "proj-2", name: "Kenya Solar Grid" };
    const { rerender } = render(
      <ProjectMapMarker project={project} position={[0, 0]} />,
    );
    expect(
      screen.getByRole("button", {
        name: /view project: amazon reforestation/i,
      }),
    ).toBeInTheDocument();
    rerender(<ProjectMapMarker project={project2} position={[0, 0]} />);
    expect(
      screen.getByRole("button", { name: /view project: kenya solar grid/i }),
    ).toBeInTheDocument();
  });

  it("escapes HTML special characters in the project name to prevent XSS", () => {
    const maliciousProject = {
      ...project,
      name: '<script>alert("xss")</script>',
    };
    const { container } = render(
      <ProjectMapMarker project={maliciousProject} position={[0, 0]} />,
    );
    // The whole point of escaping: no actual <script> element must be
    // created from the project name.  If the entities were NOT escaped,
    // the HTML parser would close the aria-label attribute and instantiate
    // an executable <script> tag.
    expect(container.querySelector("script")).toBeNull();
    // The aria-label attribute stores the decoded text (the browser
    // decoded the entities when parsing the HTML), so it now contains the
    // literal project name — but it's just text, not executable HTML.
    const button = screen.getByRole("button");
    expect(button.getAttribute("aria-label")).toBe(
      'View project: <script>alert("xss")</script>',
    );
  });

  it("has no axe violations", async () => {
    const { container } = render(
      <ProjectMapMarker project={project} position={[0, 0]} />,
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("does not crash when the project name contains an apostrophe", () => {
    // The escapeHtml helper must handle single quotes that some HTML
    // parsers treat as attribute delimiters.  Our escape prevents the
    // attribute from being broken, so the button renders with the full
    // decoded name as its aria-label.
    const tricky: ClimateProject = {
      ...project,
      name: "Cote d'Ivoire Reforestation",
    };
    render(<ProjectMapMarker project={tricky} position={[0, 0]} />);
    const button = screen.getByRole("button", {
      name: /view project: cote d'ivoire reforestation/i,
    });
    expect(button).toBeInTheDocument();
  });
});
