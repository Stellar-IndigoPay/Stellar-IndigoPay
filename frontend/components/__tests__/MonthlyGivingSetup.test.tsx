/**
 * __tests__/MonthlyGivingSetup.test.tsx
 *
 * Verifies the Monthly Giving modal follows the WAI-ARIA dialog pattern and
 * passes a basic axe-core scan with no critical or serious violations.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
// jest-axe ships without TypeScript declarations; the ambient shim lives
// at frontend/types/jest-axe.d.ts and is picked up by tsconfig.json.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
import { axe } from "jest-axe";
import MonthlyGivingSetup from "../MonthlyGivingSetup";

// Note: toHaveNoViolations is registered globally for every test suite by
// frontend/jest.setup.ts, so it does not need to be re-imported here.

const mockGetMonthlySubscription = jest.fn();
jest.mock("@/lib/monthlyGiving", () => ({
  createMonthlySubscription: jest.fn(),
  cancelMonthlySubscription: jest.fn(),
  getMonthlySubscription: (...args: any[]) =>
    mockGetMonthlySubscription(...args),
  MIN_SUBSCRIPTION_INTERVAL_LEDGERS: 17280,
}));

// Deterministic projectId/publicKey so getMonthlySubscription's mock
// resolves to "not subscribed" (null) and the form renders, rather than
// the "Active subscription" branch.
const PROJECT_ID = "test-project";
const PROJECT_NAME = "Amazon Reforestation";
const PUBLIC_KEY = "GDONORAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describe("MonthlyGivingSetup modal a11y", () => {
  beforeEach(() => {
    mockGetMonthlySubscription.mockReset();
    mockGetMonthlySubscription.mockResolvedValue(null);
  });

  it("exposes the proper WAI-ARIA dialog metadata", () => {
    render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        publicKey={PUBLIC_KEY}
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
        publicKey={PUBLIC_KEY}
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
        publicKey={PUBLIC_KEY}
        onClose={onClose}
      />,
    );
    // Wait for useFocusTrap's setTimeout(…, 0) to finish wiring the
    // keydown listener before dispatching the Escape key.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("associates labels with form fields once subscription status has loaded", async () => {
    render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        publicKey={PUBLIC_KEY}
        onClose={() => {}}
      />,
    );
    expect(
      await screen.findByLabelText(/amount \(xlm\)/i),
    ).toBeInTheDocument();
  });

  it("has no axe violations (critical/serious)", async () => {
    const { container, findByLabelText } = render(
      <MonthlyGivingSetup
        projectId={PROJECT_ID}
        projectName={PROJECT_NAME}
        publicKey={PUBLIC_KEY}
        onClose={() => {}}
      />,
    );
    // Wait for the subscription-status fetch to settle so the scan runs
    // against the form (not the transient "Checking…" state).
    await findByLabelText(/amount \(xlm\)/i);
    const results = await axe(container);
    // Only fail the build on critical/serious issues per WCAG 2.1 AA scope.
    type Violation = (typeof results.violations)[number];
    const blocking = results.violations.filter((v: Violation) =>
      ["critical", "serious"].includes(v.impact ?? ""),
    );
    expect(blocking).toEqual([]);
  });
});
