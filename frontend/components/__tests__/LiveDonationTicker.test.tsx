import { render, screen, act } from "@testing-library/react";
import LiveDonationTicker from "../LiveDonationTicker";
import type { Donation } from "../LiveDonationTicker";

const mockDonations: Donation[] = [
  {
    id: "don-1",
    projectId: "proj-alpha",
    projectName: "Amazon Tree Restoration",
    amountXLM: "150",
    createdAt: "2026-07-19T00:00:00.000Z",
  },
  {
    id: "don-2",
    projectId: "proj-beta",
    projectName: "Sahara Solar Farm",
    amountXLM: "500",
    createdAt: "2026-07-19T01:00:00.000Z",
  },
  {
    id: "don-3",
    projectId: "proj-gamma",
    projectName: "Ocean Cleanup Array",
    amountXLM: "25.5",
    createdAt: "2026-07-19T02:00:00.000Z",
  },
];

describe("LiveDonationTicker", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("returns null when donations array is empty", () => {
    const { container } = render(<LiveDonationTicker donations={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders a single donation and does not start rotation timer", () => {
    render(<LiveDonationTicker donations={[mockDonations[0]]} />);
    expect(screen.getByText("Amazon Tree Restoration")).toBeInTheDocument();
    expect(screen.getByText("150 XLM")).toBeInTheDocument();

    act(() => {
      jest.advanceTimersByTime(3500);
    });

    expect(screen.getByText("Amazon Tree Restoration")).toBeInTheDocument();
  });

  it("cycles through multiple donations every 3.5 seconds", () => {
    render(<LiveDonationTicker donations={mockDonations} />);

    // First donation shown initially
    expect(screen.getByText("Amazon Tree Restoration")).toBeInTheDocument();

    // Tick 1 (3500ms) -> second donation
    act(() => {
      jest.advanceTimersByTime(3500);
    });
    expect(screen.getByText("Sahara Solar Farm")).toBeInTheDocument();

    // Tick 2 (3500ms) -> third donation
    act(() => {
      jest.advanceTimersByTime(3500);
    });
    expect(screen.getByText("Ocean Cleanup Array")).toBeInTheDocument();

    // Tick 3 (3500ms) -> wraps around to first donation
    act(() => {
      jest.advanceTimersByTime(3500);
    });
    expect(screen.getByText("Amazon Tree Restoration")).toBeInTheDocument();
  });

  it("cleans up interval on unmount", () => {
    const clearIntervalSpy = jest.spyOn(window, "clearInterval");
    const { unmount } = render(<LiveDonationTicker donations={mockDonations} />);

    unmount();

    expect(clearIntervalSpy).toHaveBeenCalled();
    clearIntervalSpy.mockRestore();
  });

  it("formats XLM amount correctly and renders correct project link", () => {
    render(<LiveDonationTicker donations={[mockDonations[0]]} />);

    const link = screen.getByRole("link", { name: "Amazon Tree Restoration" });
    expect(link).toHaveAttribute("href", "/projects/proj-alpha");
    expect(screen.getByText("150 XLM")).toBeInTheDocument();
  });

  it("resets index to 0 if index exceeds donations array length", () => {
    const { rerender } = render(<LiveDonationTicker donations={mockDonations} />);

    // Advance timer so tickerIndex is 2 (Ocean Cleanup Array)
    act(() => {
      jest.advanceTimersByTime(7000);
    });
    expect(screen.getByText("Ocean Cleanup Array")).toBeInTheDocument();

    // Rerender with a smaller array of 1 item
    rerender(<LiveDonationTicker donations={[mockDonations[0]]} />);

    expect(screen.getByText("Amazon Tree Restoration")).toBeInTheDocument();
  });
});
