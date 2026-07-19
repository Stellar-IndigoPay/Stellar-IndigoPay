/**
 * components/__tests__/LeaderboardTable.error.test.tsx
 *
 * Integration test for inline data-fetch error handling. Mocks the backend
 * `fetchLeaderboard` so we can drive:
 *   1. A failed first load → inline QueryErrorFallback renders (shell intact).
 *   2. Clicking "Try Again" calls refetch() and, when the retry succeeds, the
 *      normal leaderboard table is restored.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import LeaderboardTable from "@/components/LeaderboardTable";
import { fetchLeaderboard } from "@/lib/api";
import type { LeaderboardEntry } from "@/utils/types";

jest.mock("@/lib/api", () => ({
  fetchLeaderboard: jest.fn(),
}));

const mockedFetchLeaderboard = fetchLeaderboard as jest.Mock;

const entry: LeaderboardEntry = {
  publicKey: "GABC",
  displayName: "Test Donor",
  totalDonatedXLM: "100",
  projectsSupported: 3,
  rank: 1,
  topBadge: "tree",
};

describe("LeaderboardTable inline error handling", () => {
  afterEach(() => {
    jest.resetAllMocks();
  });

  it("shows the inline fallback on failure and refetches on retry", async () => {
    mockedFetchLeaderboard
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce([entry]);

    render(<LeaderboardTable limit={10} period="all" />);

    // Error fallback appears (no navigation shell replacement).
    const alert = await screen.findByRole("alert");
    expect(alert).toBeInTheDocument();
    expect(screen.getByText(/server error/i)).toBeInTheDocument();

    // Retry triggers a refetch.
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));

    // After a successful retry the normal table content is restored.
    await waitFor(() => {
      expect(screen.getByText("Test Donor")).toBeInTheDocument();
    });
    expect(mockedFetchLeaderboard).toHaveBeenCalledTimes(2);
  });

  it("keeps the retry button disabled while retrying", async () => {
    // First load fails; the retry resolves on a timer so there is a window
    // where the in-flight "Retrying…" disabled state is visible.
    mockedFetchLeaderboard
      .mockRejectedValueOnce({ code: "ERR_NETWORK" })
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve([]), 50)),
      );

    render(<LeaderboardTable limit={10} period="all" />);

    const button = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(button);

    // While retrying the call is in flight; button becomes disabled.
    const retryingButton = await screen.findByRole("button", {
      name: /retrying/i,
    });
    expect(retryingButton).toBeDisabled();
  });
});
