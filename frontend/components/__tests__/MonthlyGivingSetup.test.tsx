/**
 * __tests__/MonthlyGivingSetup.test.tsx
 *
 * Verifies the Monthly Giving modal follows the WAI-ARIA dialog pattern and
 * passes a basic axe-core scan with no critical or serious violations.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { axe, toHaveNoViolations } from "jest-axe";
import MonthlyGivingSetup from "../MonthlyGivingSetup";

expect.extend(toHaveNoViolations);

// Provide a deterministic projectId so the storage subset returns []
// (we don't want localStorage state leaking between test runs).
const PROJECT_ID = "test-project";
const PROJECT_NAME = "Amazon Reforestation";

describe("MonthlyGivingSetup modal a11y", () => {
  it("exposes the proper WAI-ARIA dialog metadata", () => {
    render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        onClose={() => {}}
      />,
    );

    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute(
      "aria-labelledby",
      "monthly-giving-setup-title",
    );
    expect(
      screen.getByRole("heading", { name: /monthly giving setup/i }),
    ).toBeInTheDocument();
  });

  it("gives the close button an accessible label", () => {
    render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        onClose={() => {}}
      />,
    );
    expect(
      screen.getByRole("button", { name: /close monthly giving setup/i }),
    ).toBeInTheDocument();
  });

  it("presses Escape to call onClose", async () => {
    const onClose = jest.fn();
    const user = userEvent.setup();
    render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        onClose={onClose}
      />,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("associates labels with form fields", () => {
    render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        onClose={() => {}}
      />,
    );
    expect(screen.getByLabelText(/amount \(xlm\)/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/start date/i)).toBeInTheDocument();
  });

  it("has no axe violations (critical/serious)", async () => {
    const { container } = render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        onClose={() => {}}
      />,
    );
    const results = await axe(container);
    // Only fail the build on critical/serious issues per WCAG 2.1 AA scope.
    const blocking = results.violations.filter((v: { impact?: string | null }) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    );
    expect(blocking).toEqual([]);
  });
});
