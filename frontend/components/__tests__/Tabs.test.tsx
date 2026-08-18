/**
 * __tests__/Tabs.test.tsx
 *
 * Regression test for the WAI-ARIA 1.1 Tab Pattern implementation in
 * `frontend/components/Tabs.tsx`. Ensures:
 *   1. The tablist container has role="tablist" + accessible aria-label.
 *   2. Every tab is a real role="tab" button with aria-selected, tabIndex
 *      roving (only the active tab has tabIndex=0), and aria-controls
 *      pointing at the rendered panel id.
 *   3. The active panel is a role="tabpanel" with aria-labelledby.
 *   4. ArrowLeft/ArrowRight/Home/End keyboard navigation cycles tabs and
 *      moves focus to the newly-selected tab.
 *   5. Click-to-switch still works.
 *   6. The rendered DOM has zero axe-core critical/serious violations.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// jest-axe ships without types; declaration lives at frontend/types/jest-axe.d.ts.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { axe } from "jest-axe";
import Tabs from "../Tabs";

const MOCK_TABS = [
  {
    id: "t1",
    label: "Tab 1",
    content: <p data-testid="panel-1">Content 1</p>,
  },
  {
    id: "t2",
    label: "Tab 2",
    content: <p data-testid="panel-2">Content 2</p>,
  },
  {
    id: "t3",
    label: "Tab 3",
    content: <p data-testid="panel-3">Content 3</p>,
  },
];

describe("Tabs (WAI-ARIA Tab Pattern)", () => {
  it("exposes role=tablist, role=tab buttons, and role=tabpanel with correct IDs/labels", () => {
    render(<Tabs ariaLabel="Sections" tabs={MOCK_TABS} />);

    const tablist = screen.getByRole("tablist");
    expect(tablist).toHaveAttribute("aria-label", "Sections");

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);

    // First tab is selected by default.
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("tabIndex", "0");
    expect(tabs[1]).toHaveAttribute("aria-selected", "false");
    expect(tabs[1]).toHaveAttribute("tabIndex", "-1");

    // Each tab has AA tab id that the corresponding tabpanel references via aria-labelledby.
    // Only the active tab's panel is rendered in the DOM (inactive panels return null).
    for (const tab of tabs) {
      const tabId = tab.getAttribute("id") ?? "";
      const controlsId = tab.getAttribute("aria-controls") ?? "";
      expect(controlsId).toMatch(/^tabpanel-/);

      // Only the active tab has its panel rendered.
      const isActive = tab.getAttribute("aria-selected") === "true";
      if (isActive) {
        const panel = document.getElementById(controlsId);
        expect(panel).not.toBeNull();
        expect(panel).toHaveAttribute("aria-labelledby", tabId);
        // AAaria-controls must point to a real node in the same document.
        expect(tab.getAttribute("aria-controls")).toBe(panel!.id);
      }
    }

    // Only the active panel is rendered.
    expect(screen.getByText("Content 1")).toBeInTheDocument();
    expect(screen.queryByText("Content 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Content 3")).not.toBeInTheDocument();
  });

  it("switches the active tab on click and updates aria-selected / tabIndex", async () => {
    const user = userEvent.setup();
    render(<Tabs ariaLabel="Sections" tabs={MOCK_TABS} />);

    await user.click(screen.getByRole("tab", { name: "Tab 3" }));

    const tabs = screen.getAllByRole("tab");
    expect(tabs[2]).toHaveAttribute("aria-selected", "true");
    expect(tabs[2]).toHaveAttribute("tabIndex", "0");
    expect(tabs[0]).toHaveAttribute("tabIndex", "-1");
    expect(tabs[1]).toHaveAttribute("tabIndex", "-1");

    expect(screen.getByText("Content 3")).toBeInTheDocument();
    expect(screen.queryByText("Content 1")).not.toBeInTheDocument();
  });

  it("cycles with ArrowLeft/ArrowRight and wraps at both ends", async () => {
    const user = userEvent.setup();
    render(<Tabs ariaLabel="Sections" tabs={MOCK_TABS} />);

    const tabs = screen.getAllByRole("tab");
    tabs[0].focus();
    expect(tabs[0]).toHaveFocus();

    await user.keyboard("{ArrowRight}");
    expect(tabs[1]).toHaveFocus();
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowRight}");
    expect(tabs[2]).toHaveFocus();

    // Wrap: ArrowRight from the last tab returns to the first.
    await user.keyboard("{ArrowRight}");
    expect(tabs[0]).toHaveFocus();

    // Wrap backward: ArrowLeft from the first tab jumps to the last.
    await user.keyboard("{ArrowLeft}");
    expect(tabs[2]).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(tabs[1]).toHaveFocus();
  });

  it("supports Home and End keys", async () => {
    const user = userEvent.setup();
    render(<Tabs ariaLabel="Sections" tabs={MOCK_TABS} />);

    const tabs = screen.getAllByRole("tab");
    // Start focused on tab 3 so we can verify Home jumps back.
    await user.click(tabs[2]);
    expect(tabs[2]).toHaveFocus();

    await user.keyboard("{Home}");
    expect(tabs[0]).toHaveFocus();

    await user.keyboard("{End}");
    expect(tabs[2]).toHaveFocus();
  });

  it("honors a controlled `value` and reports changes via onChange", async () => {
    const onChange = jest.fn();
    const user = userEvent.setup();
    render(
      <Tabs
        ariaLabel="Sections"
        tabs={MOCK_TABS}
        value="t2"
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Content 2")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Tab 1" }));
    // Controlled mode does not mutate DOM-tab state unless parent updates.
    expect(screen.getByText("Content 2")).toBeInTheDocument();
    expect(onChange).toHaveBeenCalledWith("t1");
  });

  it("renders custom ReactNode tab labels (e.g. badge counts) inside the tab button", () => {
    render(
      <Tabs
        ariaLabel="Sections"
        tabs={[
          {
            id: "saved",
            label: (
              <>
                Saved Projects{" "}
                <span aria-label="3 saved">3</span>
              </>
            ),
            content: <p>Saved list</p>,
          },
        ]}
      />,
    );

    expect(screen.getByText("Saved Projects")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /saved projects/i })).toBeInTheDocument();
  });

  it("renders with no axe-core critical/serious violations", async () => {
    const { container } = render(
      <Tabs ariaLabel="Sections" tabs={MOCK_TABS} />,
    );
    const results = await axe(container);
    const blocking = results.violations.filter((v) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    );
    expect(blocking).toEqual([]);
  });
});
