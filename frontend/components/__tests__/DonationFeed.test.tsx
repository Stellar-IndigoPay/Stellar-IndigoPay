/** @jest-environment jsdom */
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DonationFeed from "@/components/DonationFeed";
import { queryKeys } from "@/hooks/queries";
import { streamProjectPayments } from "@/lib/stellar";

jest.mock("@/lib/api", () => ({
  fetchProjectDonations: jest.fn(),
}));

jest.mock("@/lib/stellar", () => ({
  explorerUrl: (hash: string) => `https://stellar.expert/tx/${hash}`,
  streamProjectPayments: jest.fn(),
}));

const mockedStreamProjectPayments = streamProjectPayments as jest.Mock;

type Payment = {
  id: string;
  from: string;
  amount: string;
  asset: string;
  createdAt: string;
  transactionHash: string;
};

describe("DonationFeed SSE deduplication", () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it("does not notify twice when the same SSE donation is received twice", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
    });
    const projectId = "project-1";
    queryClient.setQueryData(queryKeys.projectDonations(projectId, 10), {
      pages: [{ donations: [], nextCursor: null }],
      pageParams: [undefined],
    });

    let onPayment: ((payment: Payment) => void) | undefined;
    mockedStreamProjectPayments.mockImplementation(
      (_wallet: string, callback: (payment: Payment) => void) => {
        onPayment = callback;
        return jest.fn();
      },
    );
    const onNewDonation = jest.fn();

    function Wrapper({ children }: { children: React.ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>
          {children}
        </QueryClientProvider>
      );
    }

    render(
      <DonationFeed
        projectId={projectId}
        walletAddress="GPROJECT"
        onNewDonation={onNewDonation}
      />,
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(onPayment).toBeDefined());

    const payment = {
      id: "payment-1",
      from: "GDONOR",
      amount: "5",
      asset: "XLM",
      createdAt: "2026-01-01T00:00:00.000Z",
      transactionHash: "tx-1",
    };
    await act(async () => {
      onPayment?.(payment);
      onPayment?.(payment);
    });

    expect(onNewDonation).toHaveBeenCalledTimes(1);
    expect(
      queryClient.getQueryData(queryKeys.projectDonations(projectId, 10)),
    ).toMatchObject({
      pages: [{ donations: [{ transactionHash: "tx-1" }] }],
    });
  });
});
