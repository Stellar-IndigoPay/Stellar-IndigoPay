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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  function Wrapper({ children }: { children: React.ReactNode }) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    return (
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    );
  }

  afterEach(() => {
    jest.resetAllMocks();
  });

  it("shows the inline fallback on failure and refetches on retry", async () => {
    mockedFetchLeaderboard
      .mockRejectedValueOnce({ response: { status: 500 } })
      .mockResolvedValueOnce([entry]);

    render(<LeaderboardTable limit={10} period="all" />, { wrapper: Wrapper });

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

  it("renders empty state after a successful retry", async () => {
    // First load fails; the retry resolves with empty data.
    mockedFetchLeaderboard
      .mockRejectedValueOnce({ code: "ERR_NETWORK" })
      .mockResolvedValueOnce([]);

    render(<LeaderboardTable limit={10} period="all" />, { wrapper: Wrapper });

    // Error fallback appears.
    const button = await screen.findByRole("button", { name: /try again/i });
    expect(button).toBeInTheDocument();

    fireEvent.click(button);

    // After a successful retry with empty data, the empty state is shown.
    await waitFor(() => {
      expect(screen.getByText(/no donors yet/i)).toBeInTheDocument();
    });
  });
});
