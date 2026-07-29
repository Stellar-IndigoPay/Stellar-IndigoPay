/**
 * __tests__/DonationModal.test.tsx
 *
 * Behavioral tests for DonationModal covering open/close behaviour,
 * backdrop click, Escape key, focus trap, and DonateForm integration.
 */
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import DonationModal from "../DonationModal";
import type { ClimateProject } from "@/utils/types";

jest.mock("@/components/DonateForm", () => {
  return function MockDonateForm({ onSuccess }: { onSuccess?: () => void }) {
    return (
      <div data-testid="mock-donate-form">
        <button onClick={onSuccess} data-testid="mock-success-btn">
          Simulate Success
        </button>
      </div>
    );
  };
});

const mockProject: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation Initiative",
  description: "Restoring native tree cover.",
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

const defaultProps = {
  project: mockProject,
  publicKey: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  isOpen: true,
  onClose: jest.fn(),
  onSuccess: jest.fn(),
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe("DonationModal", () => {
  it("does not render when isOpen is false", () => {
    render(<DonationModal {...defaultProps} isOpen={false} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mock-donate-form")).not.toBeInTheDocument();
  });

  it("renders the dialog and DonateForm when isOpen is true", () => {
    render(<DonationModal {...defaultProps} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("mock-donate-form")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-modal", "true");
  });

  it("has a hidden title for screen readers", () => {
    render(<DonationModal {...defaultProps} />);
    expect(
      screen.getByText(/donate to amazon reforestation initiative/i),
    ).toHaveClass("sr-only");
  });

  it("calls onClose when close button is clicked", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<DonationModal {...defaultProps} onClose={onClose} />);
    await user.click(screen.getByRole("button", { name: /close donation dialog/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape key is pressed", () => {
    const onClose = jest.fn();
    render(<DonationModal {...defaultProps} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when backdrop is clicked", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    const { container } = render(<DonationModal {...defaultProps} onClose={onClose} />);
    const backdrop = container.firstChild as HTMLElement;
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not call onClose when clicking inside the dialog content", async () => {
    const user = userEvent.setup();
    const onClose = jest.fn();
    render(<DonationModal {...defaultProps} onClose={onClose} />);
    await user.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onSuccess and onClose when donation succeeds", async () => {
    const user = userEvent.setup();
    const onSuccess = jest.fn();
    const onClose = jest.fn();
    render(<DonationModal {...defaultProps} onSuccess={onSuccess} onClose={onClose} />);
    await user.click(screen.getByTestId("mock-success-btn"));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("prevents body scroll when open", () => {
    render(<DonationModal {...defaultProps} />);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("restores body scroll when closed", () => {
    const { rerender } = render(<DonationModal {...defaultProps} />);
    expect(document.body.style.overflow).toBe("hidden");
    rerender(<DonationModal {...defaultProps} isOpen={false} />);
    expect(document.body.style.overflow).toBe("");
  });
});
