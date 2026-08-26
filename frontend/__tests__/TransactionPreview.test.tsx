/**
 * __tests__/TransactionPreview.test.tsx
 *
 * Workstream 5 — the "no blind signing" preview component.  Verifies it
 * renders the destination, amount, fee, and total debited; that the
 * confirmation checkbox gates the sign action; and that it announces the
 * summary to screen readers (Workstream 7).
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";

jest.mock("@/lib/stellar", () => ({
  NETWORK: "testnet",
  shortenAddressForPreview: (a: string) =>
    a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-3)}` : a,
}));

import TransactionPreview from "@/components/TransactionPreview";

const PROJECT_WALLET = "GABC1234567890123456789012345678901234567890123456789XYZ";

const simulation = {
  destination: PROJECT_WALLET,
  amount: "10",
  currency: "XLM" as const,
  feeStroops: 100,
  feeXLM: "0.0000100",
  totalDebited: "10.0000100",
  sequence: "123",
};

function renderPreview(
  overrides: Omit<Partial<typeof simulation>, "totalDebited"> & {
    totalDebited?: string | null;
  } = {},
) {
  const onConfirm = jest.fn();
  const onBack = jest.fn();
  render(
    <TransactionPreview
      simulation={{ ...simulation, ...overrides }}
      projectName="Rainforest Alliance"
      onConfirm={onConfirm}
      onBack={onBack}
    />,
  );
  return { onConfirm, onBack };
}

describe("TransactionPreview", () => {
  it("renders destination, amount, fee, and total debited", () => {
    renderPreview();

    expect(screen.getByTestId("preview-amount")).toHaveTextContent("10 XLM");
    expect(screen.getByTestId("preview-fee")).toHaveTextContent(
      "0.0000100 XLM",
    );
    expect(screen.getByTestId("preview-total")).toHaveTextContent("10 XLM");
    // Destination is truncated but recognizable.
    expect(screen.getByTestId("preview-destination")).toHaveTextContent(
      "GABC…XYZ",
    );
  });

  it("keeps the confirm button disabled until the checkbox is checked", () => {
    const { onConfirm } = renderPreview();

    const confirmButton = screen.getByTestId("preview-confirm-button");
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByTestId("preview-confirm-checkbox"));
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("fires onBack when the donor wants to edit", () => {
    const { onBack } = renderPreview();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("announces the summary via an aria-live region", async () => {
    renderPreview();

    // The region mounts empty and receives the announcement via an effect
    // after render — await the post-effect update.
    const liveRegion = await screen.findByTestId("preview-live-region");
    await waitFor(() => {
      expect(liveRegion).toHaveTextContent(
        /You are donating 10 XLM to Rainforest Alliance/,
      );
    });
    expect(liveRegion).toHaveAttribute("aria-live", "polite");
  });

  it("omits the total-debited row when totalDebited is null (USDC)", () => {
    renderPreview({ totalDebited: null });

    // USDC donations pay the fee in XLM separately, so there is no combined
    // "total debited from wallet" row to show.
    expect(screen.queryByTestId("preview-total")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Total debited from wallet"),
    ).not.toBeInTheDocument();
  });

  it("has no axe violations", async () => {
    renderPreview();

    const results = await axe(screen.getByTestId("transaction-preview"));
    expect(results).toHaveNoViolations();
  });
});
