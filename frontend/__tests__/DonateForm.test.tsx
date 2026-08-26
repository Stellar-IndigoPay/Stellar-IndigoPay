/**
 * __tests__/DonateForm.test.tsx
 *
 * Tests for the hardened donation form (issue #1096):
 *  - Workstream 1: amount presets, impact preview, Max button, and
 *    insufficient-balance validation that disables submission.
 *  - Workstream 5: the V2 transaction preview gates the wallet prompt and a
 *    confirmation checkbox must be checked before signing.
 *  - Workstream 6: a wallet rejection returns to a clean form with a
 *    dismissible notice — it is a cancel, not an error.
 */
import React from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { axe } from "jest-axe";

var mockGetAccountSummary: jest.Mock = jest.fn().mockResolvedValue({
  balance: "100",
  subentries: 0,
  numSponsoring: 0,
  numSponsored: 0,
});
var mockGetBaseReserveXLM: jest.Mock = jest.fn().mockResolvedValue(2);
var mockGetAssetBalance: jest.Mock = jest.fn().mockResolvedValue(null);
var mockBuildDonationTransaction: jest.Mock = jest.fn().mockResolvedValue({
  toXDR: () => "UNSIGNED_XDR",
  hash: () => ({ toString: () => "a".repeat(64) }),
  operations: [],
  sequence: "123",
});
var mockSimulateDonation: jest.Mock = jest.fn();
var mockSubmitTransaction: jest.Mock = jest.fn().mockResolvedValue({
  hash: "a".repeat(64),
});
var mockSignTransactionWithWallet: jest.Mock = jest.fn().mockResolvedValue({
  signedXDR: "SIGNED_XDR",
  error: null,
});
var mockRecordDonation: jest.Mock = jest.fn().mockResolvedValue({});
var mockCheckIdempotency: jest.Mock = jest.fn().mockResolvedValue(false);
var mockMutateAsync: jest.Mock = jest.fn().mockResolvedValue({});
var mockTrackEvent: jest.Mock = jest.fn();
var mockQueueDonation: jest.Mock = jest.fn().mockResolvedValue(null);
var mockIsOnline = true;

jest.mock("@/lib/stellar", () => ({
  getAccountSummary: (...args: unknown[]) => mockGetAccountSummary(...args),
  getBaseReserveXLM: (...args: unknown[]) => mockGetBaseReserveXLM(...args),
  getAssetBalance: (...args: unknown[]) => mockGetAssetBalance(...args),
  buildDonationTransaction: (...args: unknown[]) =>
    mockBuildDonationTransaction(...args),
  buildContractDonationTransaction: jest.fn().mockResolvedValue({
    toXDR: () => "XDR",
  }),
  buildCreateRecurringTransaction: jest.fn().mockResolvedValue({
    toXDR: () => "XDR",
  }),
  buildApproveTransaction: jest.fn().mockResolvedValue({ toXDR: () => "XDR" }),
  submitTransaction: (...args: unknown[]) => mockSubmitTransaction(...args),
  explorerUrl: (h: string) => `https://stellar.expert/tx/${h}`,
  getDonorStats: jest.fn().mockResolvedValue(null),
  hashMessage: () => 0,
  CONTRACT_ID: "",
  NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  estimateFeeStroops: () => 100,
  calculateMaxDonation: () => "97.9999899",
  calculateMinimumReserveXLM: (sub: number, sponsoring: number, base: number) =>
    base * (2 + sub + sponsoring),
  BASE_RESERVE_XLM: 2,
  STROOPS_PER_XLM: 10_000_000,
  formatFeeXLM: () => "0.0000100 XLM",
  stroopsToXLM: (s: number) => (s / 10_000_000).toFixed(7),
  simulateDonation: (...args: unknown[]) => mockSimulateDonation(...args),
  pollTransaction: jest.fn(),
  NETWORK: "testnet",
  shortenAddressForPreview: (a: string) =>
    a.length > 8 ? `${a.slice(0, 4)}…${a.slice(-3)}` : a,
}));

jest.mock("@/lib/wallet", () => ({
  signTransactionWithWallet: (...args: unknown[]) =>
    mockSignTransactionWithWallet(...args),
}));

jest.mock("@/lib/api", () => ({
  recordDonation: (...args: unknown[]) => mockRecordDonation(...args),
  checkIdempotency: (...args: unknown[]) => mockCheckIdempotency(...args),
}));

jest.mock("@/hooks/queries", () => ({
  useRecordDonation: () => ({ mutateAsync: mockMutateAsync }),
}));

jest.mock("@/hooks/useOnlineStatus", () => ({
  __esModule: true,
  default: () => mockIsOnline,
}));

jest.mock("@/lib/offlineDonationQueue", () => ({
  queueDonation: (...args: unknown[]) => mockQueueDonation(...args),
  syncQueuedDonations: jest.fn().mockResolvedValue(undefined),
  getQueuedCount: jest.fn().mockResolvedValue(0),
}));

jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrackEvent(...args),
}));

jest.mock("@/lib/priceContext", () => ({
  usePriceContext: () => ({
    xlmUsd: 0.1,
    isStale: false,
    isDegraded: false,
    priceAgeMs: 0,
  }),
}));

jest.mock("@/lib/featureFlags", () => ({
  ENABLE_DONATION_V2: true,
}));

import DonateForm from "@/components/DonateForm";
import type { ClimateProject } from "@/utils/types";

const PROJECT: ClimateProject = {
  id: "project_123",
  name: "Rainforest Alliance",
  walletAddress: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  co2_per_xlm: 250,
  description: "A test project",
} as ClimateProject;

const DONOR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function renderForm() {
  return render(
    <DonateForm project={PROJECT} publicKey={DONOR} />,
  );
}

describe("DonateForm — Workstream 1 (overview)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline = true;
    mockGetAccountSummary.mockResolvedValue({
      balance: "100",
      subentries: 0,
      numSponsoring: 0,
      numSponsored: 0,
    });
    mockGetBaseReserveXLM.mockResolvedValue(2);
    mockGetAssetBalance.mockResolvedValue(null);
  });

  it("renders amount presets and updates the CO₂ impact preview live", async () => {
    renderForm();

    // Preset quick-select buttons for XLM.
    expect(screen.getByRole("button", { name: "10 XLM" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "250 XLM" })).toBeInTheDocument();

    const input = screen.getByTestId("donation-amount");
    fireEvent.change(input, { target: { value: "10" } });

    // 10 XLM × 250 kg CO₂ / 1000 = 2.5 kg offset preview.
    await waitFor(() => {
      expect(
        screen.getByText(/offset approximately/i),
      ).toBeInTheDocument();
    });
    expect(screen.getByText(/2\.5\s*kg CO₂/i)).toBeInTheDocument();
  });

  it("shows the estimated network fee and the Max button", async () => {
    renderForm();

    await waitFor(() => {
      expect(screen.getByTestId("fee-estimate")).toHaveTextContent(
        "Estimated network fee: 0.0000100 XLM",
      );
    });

    const maxButton = screen.getByTestId("max-button");
    expect(maxButton).toBeInTheDocument();

    fireEvent.click(maxButton);
    expect(screen.getByTestId("donation-amount")).toHaveValue(97.9999899);
  });

  it("disables submission and shows an error when the amount exceeds the balance", async () => {
    mockGetAccountSummary.mockResolvedValue({
      balance: "95",
      subentries: 0,
      numSponsoring: 0,
      numSponsored: 0,
    });
    renderForm();

    await waitFor(() => {
      expect(screen.getByTestId("donation-amount")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "100" },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("insufficient-balance-error"),
      ).toHaveTextContent(
        "Insufficient balance (98.00 XLM available after the 4.00 XLM account reserve and network fee)",
      );
    });

    // Submit is disabled while the amount exceeds the balance.
    expect(screen.getByTestId("donate-button")).toBeDisabled();
  });

  it("blocks amounts above the reserve-aware Max even when below the raw balance", async () => {
    // Balance 100 → max ≈ 97.9999899 (reserve 2 + fee + 1 stroop). Typing 99
    // is under the raw balance but above the Max — the submit gate must agree
    // with the Max button so the donor never signs a doomed transaction.
    renderForm();

    await waitFor(() => {
      expect(screen.getByTestId("donation-amount")).toBeInTheDocument();
    });

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "99" },
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("insufficient-balance-error"),
      ).toHaveTextContent(
        "Insufficient balance (98.00 XLM available after the 4.00 XLM account reserve and network fee)",
      );
    });
    expect(screen.getByTestId("donate-button")).toBeDisabled();
  });
});

describe("DonateForm — Workstream 2 (offline queued confirmation)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline = false;
    mockGetAccountSummary.mockResolvedValue({
      balance: "500",
      subentries: 0,
      numSponsoring: 0,
      numSponsored: 0,
    });
    mockGetBaseReserveXLM.mockResolvedValue(2);
    mockGetAssetBalance.mockResolvedValue(null);
  });

  it("queues the donation and keeps the form usable with a notice (not a success card)", async () => {
    renderForm();

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("donate-button"));

    // The donation is queued with the flow's idempotency key so a retry can
    // never double-record.
    await waitFor(() => {
      expect(mockQueueDonation).toHaveBeenCalledTimes(1);
    });
    expect(mockQueueDonation).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: "10",
        currency: "XLM",
        idempotencyKey: expect.any(String),
      }),
    );

    // Queued ≠ success: a dismissible notice appears, the form returns to
    // the idle step, and the donate button is usable again.
    await waitFor(() => {
      expect(screen.getByTestId("cancel-notice")).toHaveTextContent(
        /queued/i,
      );
    });
    expect(screen.queryByTestId("donation-queued")).not.toBeInTheDocument();
    expect(screen.getByTestId("donate-form")).toBeInTheDocument();
    expect(screen.getByTestId("donate-button")).toBeEnabled();
  });
});

describe("DonateForm — Workstream 5 (transaction preview, V2)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline = true;
    mockGetAccountSummary.mockResolvedValue({
      balance: "500",
      subentries: 0,
      numSponsoring: 0,
      numSponsored: 0,
    });
    mockGetBaseReserveXLM.mockResolvedValue(2);
    mockGetAssetBalance.mockResolvedValue(null);
    mockSimulateDonation.mockResolvedValue({
      destination: PROJECT.walletAddress,
      amount: "10",
      currency: "XLM",
      feeStroops: 100,
      feeXLM: "0.0000100",
      totalDebited: "10.0000100",
      sequence: "123",
    });
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: "SIGNED_XDR",
      error: null,
    });
    mockSubmitTransaction.mockResolvedValue({ hash: "a".repeat(64) });
  });

  it("shows the preview before any wallet prompt and gates signing on the checkbox", async () => {
    renderForm();

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("donate-button"));

    // The preview appears; the wallet was NOT prompted yet.
    await waitFor(() => {
      expect(screen.getByTestId("transaction-preview")).toBeInTheDocument();
    });
    expect(screen.getByTestId("preview-amount")).toHaveTextContent("10 XLM");
    expect(screen.getByTestId("preview-total")).toHaveTextContent("10 XLM");
    expect(mockSignTransactionWithWallet).not.toHaveBeenCalled();

    // The confirm button is gated on the checkbox.
    const confirmButton = screen.getByTestId("preview-confirm-button");
    expect(confirmButton).toBeDisabled();

    fireEvent.click(screen.getByTestId("preview-confirm-checkbox"));
    expect(confirmButton).toBeEnabled();

    fireEvent.click(confirmButton);

    // Wallet prompt happens only after explicit confirmation.
    await waitFor(() => {
      expect(mockSignTransactionWithWallet).toHaveBeenCalledTimes(1);
    });
    await waitFor(() => {
      expect(screen.getByTestId("donation-success")).toBeInTheDocument();
    });
  });

  it("rebuilds the transaction fresh at confirm time (never signs a stale tx)", async () => {
    renderForm();

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("donate-button"));

    await waitFor(() => {
      expect(screen.getByTestId("transaction-preview")).toBeInTheDocument();
    });
    // V2 never builds a throwaway tx for the preview (simulateDonation builds
    // its own internally), so no discarded Horizon account load.
    expect(mockBuildDonationTransaction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("preview-confirm-checkbox"));
    fireEvent.click(screen.getByTestId("preview-confirm-button"));

    // Confirm rebuilds with the same params (fresh sequence + 60s window).
    await waitFor(() => {
      expect(mockBuildDonationTransaction).toHaveBeenCalledTimes(1);
    });
  });

  it("announces the simulation result to screen readers", async () => {
    renderForm();

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("donate-button"));

    await waitFor(() => {
      expect(screen.getByTestId("preview-live-region")).toHaveTextContent(
        /You are donating 10 XLM to Rainforest Alliance/,
      );
    });
  });

  it("has no axe violations on the preview step", async () => {
    renderForm();

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("donate-button"));

    await waitFor(() => {
      expect(screen.getByTestId("transaction-preview")).toBeInTheDocument();
    });

    const preview = screen.getByTestId("transaction-preview");
    const results = await axe(preview);
    expect(results).toHaveNoViolations();
  });
});

describe("DonateForm — Workstream 6 (wallet rejection recovery)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsOnline = true;
    mockGetAccountSummary.mockResolvedValue({
      balance: "500",
      subentries: 0,
      numSponsoring: 0,
      numSponsored: 0,
    });
    mockGetBaseReserveXLM.mockResolvedValue(2);
    mockGetAssetBalance.mockResolvedValue(null);
    mockSimulateDonation.mockResolvedValue({
      destination: PROJECT.walletAddress,
      amount: "10",
      currency: "XLM",
      feeStroops: 100,
      feeXLM: "0.0000100",
      totalDebited: "10.0000100",
      sequence: "123",
    });
    mockSignTransactionWithWallet.mockResolvedValue({
      signedXDR: null,
      error: "User declined the request",
    });
  });

  it("returns to the form with a dismissible notice instead of an error banner", async () => {
    renderForm();

    fireEvent.change(screen.getByTestId("donation-amount"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByTestId("donate-button"));

    // Preview → confirm → wallet declines the signature.
    await waitFor(() => {
      expect(screen.getByTestId("transaction-preview")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("preview-confirm-checkbox"));
    fireEvent.click(screen.getByTestId("preview-confirm-button"));

    await waitFor(() => {
      expect(screen.getByTestId("cancel-notice")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("cancel-notice"),
    ).toHaveTextContent(/Signature cancelled/i);

    // Back to a usable form — the donate button is enabled again.
    expect(screen.getByTestId("donate-button")).toBeEnabled();

    // No error banner was shown — a wallet cancel is not an error.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
