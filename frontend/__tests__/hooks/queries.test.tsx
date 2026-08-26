import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRecordDonation, queryKeys } from "@/hooks/queries";
import { recordDonation } from "@/lib/api";

jest.mock("@/lib/api", () => ({
  recordDonation: jest.fn(),
}));

describe("useRecordDonation optimistic updates", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.clear();
    jest.clearAllMocks();
  });

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  it("adds donation optimistically", async () => {
    const projectId = "proj-1";
    
    queryClient.setQueryData(queryKeys.projectDonations(projectId, null), {
      donations: [{ id: "existing-1", donorAddress: "existing-donor", amountXLM: "10" }],
      nextCursor: null,
    });

    const { result } = renderHook(() => useRecordDonation(), { wrapper });

    (recordDonation as jest.Mock).mockResolvedValueOnce({ success: true });

    act(() => {
      result.current.mutate({
        projectId,
        donorAddress: "new-donor",
        amountXLM: "20",
        transactionHash: "tx-123",
      });
    });

    await waitFor(() => {
      const queryData = queryClient.getQueryData<any>(queryKeys.projectDonations(projectId, null));
      expect(queryData.donations[0].id).toMatch(/^opt-/);
    });

    const queryData = queryClient.getQueryData<any>(queryKeys.projectDonations(projectId, null));
    expect(queryData.donations[0].donorAddress).toBe("new-donor");
    expect(queryData.donations[0].amountXLM).toBe("20");
    expect(queryData.donations).toHaveLength(2);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back optimistic update on error", async () => {
    const projectId = "proj-2";
    
    queryClient.setQueryData(queryKeys.projectDonations(projectId, null), {
      donations: [{ id: "existing-1", donorAddress: "existing-donor", amountXLM: "10" }],
      nextCursor: null,
    });

    const { result } = renderHook(() => useRecordDonation(), { wrapper });

    (recordDonation as jest.Mock).mockRejectedValueOnce(new Error("Network Error"));

    act(() => {
      result.current.mutate({
        projectId,
        donorAddress: "new-donor",
        amountXLM: "20",
        transactionHash: "tx-123",
      });
    });

    await waitFor(() => expect(result.current.isError).toBe(true));

    const rolledBackData = queryClient.getQueryData<any>(queryKeys.projectDonations(projectId, null));
    expect(rolledBackData.donations).toHaveLength(1);
    expect(rolledBackData.donations[0].id).toBe("existing-1");
  });
});
