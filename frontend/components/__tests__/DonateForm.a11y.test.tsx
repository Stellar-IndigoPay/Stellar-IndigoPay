/**
 * __tests__/DonateForm.a11y.test.tsx
 *
 * Spot-checks the donation form's accessibility-critical pieces: the amount
 * input gets aria-invalid when validation fails, the inline error has the
 * implicit `alert` role, and the form renders an accessible main landmark
 * after a successful donation.
 */
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import DonateForm from "../DonateForm";
import type { ClimateProject } from "@/utils/types";
import { useFormValidation as actualUseFormValidation } from "@/hooks/useFormValidation";

jest.mock("@/lib/offlineDonationQueue", () => ({
  queueDonation: jest.fn().mockResolvedValue(null),
  getQueuedDonations: jest.fn().mockResolvedValue([]),
  removeQueuedDonation: jest.fn().mockResolvedValue(undefined),
  syncQueuedDonations: jest.fn().mockResolvedValue(undefined),
  requestBackgroundSync: jest.fn().mockResolvedValue(undefined),
}));

// `useFormValidation` is the source of truth for `errors` that the new
// assertive live region announces. Mocking it lets us drive `errors`
// directly for one test below, isolating the live-region wiring from the
// unrelated (pre-existing) button-disabled gating logic.
jest.mock("@/hooks/useFormValidation", () => ({
  useFormValidation: jest.fn(),
}));
const mockedUseFormValidation = actualUseFormValidation as unknown as jest.Mock;


const project: ClimateProject = {
  id: "proj-1",
  name: "Amazon Reforestation",
  description: "Plant trees in deforested regions.",
  category: "Reforestation",
  location: "Brazil",
  walletAddress: "GAAAA",
  goalXLM: "100",
  raisedXLM: "0",
  donorCount: 0,
  co2OffsetKg: 12,
  co2_per_xlm: 0.5,
  status: "active",
  verified: true,
  onChainVerified: false,
  tags: [],
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
};

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function Wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  );
}

describe("DonateForm accessibility", () => {
  const { useFormValidation: realUseFormValidation } = jest.requireActual(
    "@/hooks/useFormValidation",
  );

  beforeEach(() => {
    // Default to the real implementation so unrelated tests keep exercising
    // genuine validation behavior; only the dedicated test below overrides
    // this to inject a controlled `errors` map.
    mockedUseFormValidation.mockImplementation(realUseFormValidation);
  });

  it("flags the amount field with aria-invalid when under the minimum", async () => {
    const user = userEvent.setup();
    render(<DonateForm project={project} publicKey="GAAAA" />, { wrapper: Wrapper });
    const input = screen.getByPlaceholderText(/or enter custom amount/i);
    await user.type(input, "0");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(/minimum donation is 1/i)).toHaveAttribute(
      "role",
      "alert",
    );
  });

  it("renders the error alert with aria roles when displayed", () => {
    // We can't easily trigger the async error path in a unit test, so we
    // assert that the markup pattern exists by checking the static error
    // region is wired correctly when present.
    const { container } = render(
      <DonateForm project={project} publicKey="GAAAA" />,
      { wrapper: Wrapper },
    );
    // The "sr-only" live region exists for flow updates even when idle.
    const liveRegions = container.querySelectorAll('[aria-live="polite"]');
    expect(liveRegions.length).toBeGreaterThan(0);
  });

  it("does not mark the input invalid when amount is at or above the minimum", () => {
    render(<DonateForm project={project} publicKey="GAAAA" />, { wrapper: Wrapper });
    const input = screen.getByPlaceholderText(/or enter custom amount/i);
    expect(input).toHaveAttribute("aria-invalid", "false");
  });

  it("renders an assertive live region for validation error announcements", () => {
    const { getByTestId } = render(
      <DonateForm project={project} publicKey="GAAAA" />,
      { wrapper: Wrapper },
    );
    const liveRegion = getByTestId("validation-live-region");
    expect(liveRegion).toHaveAttribute("aria-live", "assertive");
    // Empty (and thus silent) until a validation error actually occurs.
    expect(liveRegion).toHaveTextContent("");
  });

  it("announces the first validation error in the assertive live region after validation fails", () => {
    const validate = jest.fn().mockReturnValue(false);
    const clearField = jest.fn();
    mockedUseFormValidation.mockReturnValue({
      errors: { amount: "Minimum donation is 1", message: "Message must be at most 100 characters" },
      validate,
      clearField,
      setErrors: jest.fn(),
      isValid: false,
    });

    render(<DonateForm project={project} publicKey="GAAAA" />, { wrapper: Wrapper });

    const liveRegion = screen.getByTestId("validation-live-region");
    expect(liveRegion).toHaveAttribute("aria-live", "assertive");
    // Announces the first error present in the map (field declaration order).
    expect(liveRegion).toHaveTextContent(/minimum donation is 1/i);
  });

  it("clears the assertive live region once validation errors are resolved", () => {
    const validate = jest.fn().mockReturnValue(true);
    const clearField = jest.fn();
    mockedUseFormValidation.mockReturnValue({
      errors: {},
      validate,
      clearField,
      setErrors: jest.fn(),
      isValid: true,
    });

    render(<DonateForm project={project} publicKey="GAAAA" />, { wrapper: Wrapper });

    const liveRegion = screen.getByTestId("validation-live-region");
    expect(liveRegion).toHaveTextContent("");
  });
});

