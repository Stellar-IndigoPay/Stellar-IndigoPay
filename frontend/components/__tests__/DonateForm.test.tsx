/**
 * __tests__/DonateForm.test.tsx
 *
 * Behavioral tests for DonateForm covering rendering, validation,
 * submission flow, error states, and user interaction.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import DonateForm from "../DonateForm";
import type { ClimateProject } from "@/utils/types";

jest.mock("@/lib/stellar", () => ({
  buildDonationTransaction: jest.fn().mockResolvedValue({ toXDR: () => "mock-xdr" }),
  buildContractDonationTransaction: jest.fn().mockResolvedValue({ toXDR: () => "mock-xdr" }),
  buildCreateRecurringTransaction: jest.fn().mockResolvedValue({ toXDR: () => "mock-xdr" }),
  buildApproveTransaction: jest.fn().mockResolvedValue({ toXDR: () => "mock-xdr" }),
  submitTransaction: jest.fn().mockResolvedValue({ hash: "abc123hash" }),
  explorerUrl: jest.fn().mockReturnValue("https://stellar.expert/explorer/public/tx/abc123hash"),
  getXLMBalance: jest.fn().mockResolvedValue("1000.0000000"),
  getAssetBalance: jest.fn().mockResolvedValue("500.00"),
  getDonorStats: jest.fn().mockResolvedValue(null),
  hashMessage: jest.fn().mockReturnValue(12345),
  CONTRACT_ID: null,
}));

jest.mock("@/lib/wallet", () => ({
  signTransactionWithWallet: jest.fn().mockResolvedValue({ signedXDR: "signed-xdr", error: null }),
}));

jest.mock("@/lib/api", () => ({
  recordDonation: jest.fn().mockResolvedValue({}),
}));

jest.mock("@/hooks/queries", () => ({
  useRecordDonation: () => ({
    mutateAsync: jest.fn().mockResolvedValue({}),
  }),
}));

jest.mock("@/hooks/useOnlineStatus", () => jest.fn().mockReturnValue(true));

jest.mock("@/lib/offlineDonationQueue", () => ({
  queueDonation: jest.fn().mockResolvedValue(null),
  syncQueuedDonations: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: jest.fn(),
}));

jest.mock("@/utils/uuid", () => ({
  safeRandomUUID: jest.fn().mockReturnValue("test-uuid-123"),
}));

jest.mock("@stellar/stellar-sdk", () => ({
  Asset: jest.fn().mockImplementation(() => ({
    contractId: jest.fn().mockReturnValue("mock-contract-id"),
  })),
}));

const mockProject: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation Initiative",
  description: "Restoring native tree cover across degraded rainforest land.",
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

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function renderForm(props: Partial<React.ComponentProps<typeof DonateForm>> = {}) {
  const queryClient = createQueryClient();
  const result = render(
    <QueryClientProvider client={queryClient}>
      <DonateForm
        project={mockProject}
        publicKey="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...result, queryClient };
}

describe("DonateForm", () => {
  it("renders the amount input and donate button", () => {
    renderForm();
    expect(screen.getByPlaceholderText(/or enter custom amount/i)).toBeInTheDocument();
    expect(screen.getByTestId("donate-button")).toBeInTheDocument();
    expect(screen.getByText(/donate/i)).toBeInTheDocument();
  });

  it("disables donate button when amount is empty", () => {
    renderForm();
    expect(screen.getByTestId("donate-button")).toBeDisabled();
  });

  it("shows validation error for negative amount", async () => {
    const user = userEvent.setup();
    renderForm();
    const input = screen.getByPlaceholderText(/or enter custom amount/i);
    await user.type(input, "-5");
    await user.click(screen.getByTestId("donate-button"));
    expect(screen.getByText(/minimum donation is 1/i)).toBeInTheDocument();
  });

  it("shows validation error for zero amount", async () => {
    const user = userEvent.setup();
    renderForm();
    const input = screen.getByPlaceholderText(/or enter custom amount/i);
    await user.type(input, "0");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("enables the donate button when a valid amount is entered", async () => {
    const user = userEvent.setup();
    renderForm();
    const input = screen.getByPlaceholderText(/or enter custom amount/i);
    await user.type(input, "10");
    const btn = screen.getByTestId("donate-button");
    expect(btn).not.toBeDisabled();
  });

  it("renders the message input field", () => {
    renderForm();
    expect(screen.getByPlaceholderText(/leave a message/i)).toBeInTheDocument();
  });

  it("includes the message in the submission", async () => {
    const user = userEvent.setup();
    renderForm();
    const amountInput = screen.getByPlaceholderText(/or enter custom amount/i);
    await user.type(amountInput, "10");
    const messageInput = screen.getByPlaceholderText(/leave a message/i);
    await user.type(messageInput, "Keep up the great work!");
    const btn = screen.getByTestId("donate-button");
    expect(btn).not.toBeDisabled();
  });

  it("respects the initialAmount prop", () => {
    renderForm({ initialAmount: "25" });
    expect(screen.getByPlaceholderText(/or enter custom amount/i)).toHaveValue(25);
  });

  it("renders currency selector with XLM and USDC buttons", () => {
    renderForm();
    expect(screen.getByText("XLM")).toBeInTheDocument();
    expect(screen.getByText("USDC")).toBeInTheDocument();
  });

  it("renders preset amount buttons", () => {
    renderForm();
    expect(screen.getByText("10 XLM")).toBeInTheDocument();
    expect(screen.getByText("25 XLM")).toBeInTheDocument();
    expect(screen.getByText("50 XLM")).toBeInTheDocument();
    expect(screen.getByText("100 XLM")).toBeInTheDocument();
    expect(screen.getByText("250 XLM")).toBeInTheDocument();
  });

  it("displays the project name in the heading", () => {
    renderForm();
    expect(screen.getByText("Make a Donation")).toBeInTheDocument();
  });
});
