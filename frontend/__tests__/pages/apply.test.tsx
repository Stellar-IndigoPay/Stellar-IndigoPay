/**
 * @jest-environment jsdom
 *
 * Frontend tests for pages/apply.tsx — the verification request form at /apply.
 *
 * These tests use a stubbed I18nProvider that always returns the requested key
 * so we can exercise the form in English without wiring the full provider
 * tree. We also mock the project-categories import to keep the test purely
 * UX-driven.
 *
 * Updated for react-hook-form + zod: the form now uses RHF with the
 * zodResolver, so field registration uses `register()` and validation runs
 * via `trigger()` on step advance.
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Force the next/router `useRouter` hook to return a stub with a push() we can
// observe. mockReturnValue is sticky so we don't need beforeEach here.
jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), query: {}, pathname: "/apply" }),
}));

jest.mock("@/lib/i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: "en",
    setLocale: jest.fn(),
  }),
}));

jest.mock("@/utils/format", () => ({
  PROJECT_CATEGORIES: [
    "Reforestation",
    "Solar Energy",
    "Ocean Conservation",
    "Clean Water",
    "Wildlife Protection",
    "Carbon Capture",
    "Wind Energy",
    "Sustainable Agriculture",
    "Other",
  ],
}));

const mockSubmit = jest.fn();
const mockUpload = jest.fn();
jest.mock("@/lib/api", () => ({
  submitVerificationRequest: (...args: unknown[]) => mockSubmit(...args),
  uploadSupportingDocument: (...args: unknown[]) => mockUpload(...args),
}));

// Stub File so JSDOM tests can simulate user uploads.
class FakeFile {
  name: string;
  size: number;
  type: string;
  constructor(name: string, size: number, type: string) {
    this.name = name;
    this.size = size;
    this.type = type;
  }
}

import ApplyPage from "@/pages/apply";

// The i18n mock prepends "apply." to keys: T("common.next") → "apply.common.next"
const NEXT_BTN = "apply.common.next";
const SUBMIT_BTN = "apply.submit";

describe("ApplyPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("renders the first step with required organisation fields", () => {
    render(<ApplyPage />);
    expect(
      screen.getByRole("heading", { name: "apply.pageTitle" }),
    ).toBeTruthy();
    expect(screen.getByLabelText("apply.orgName *")).toBeTruthy();
    expect(screen.getByLabelText("apply.contactEmail *")).toBeTruthy();
    expect(screen.getByLabelText("apply.walletAddress *")).toBeTruthy();
  });

  test("blocks next when required fields are empty", async () => {
    render(<ApplyPage />);
    fireEvent.click(screen.getByRole("button", { name: NEXT_BTN }));

    // All required org fields trigger validation errors.
    await waitFor(() => {
      const errorMessages = screen.getAllByRole("alert");
      expect(errorMessages.length).toBeGreaterThan(0);
      const errorTexts = errorMessages.map((e) => e.textContent).join(" ");
      expect(errorTexts).toMatch(/required|Invalid/i);
    });
    expect(screen.getByText("apply.stepOrg")).toBeTruthy();
  });

  test("blocks invalid Stellar wallet and email", async () => {
    render(<ApplyPage />);

    await userEvent.type(screen.getByLabelText("apply.orgName *"), "Acme");
    await userEvent.type(
      screen.getByLabelText("apply.contactEmail *"),
      "not-an-email",
    );
    await userEvent.type(
      screen.getByLabelText("apply.walletAddress *"),
      "not-a-wallet",
    );
    fireEvent.click(screen.getByRole("button", { name: NEXT_BTN }));

    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const messages = alerts.map((a) => a.textContent).join(" ");
      expect(messages).toMatch(/Invalid/i);
    });
  });

  test("walks through the wizard and submits the form", async () => {
    mockSubmit.mockResolvedValueOnce({
      id: "abc",
      reviewTimeline: "5–10 business days",
    });
    render(<ApplyPage />);
    const user = userEvent.setup();

    // Org step
    await user.type(screen.getByLabelText("apply.orgName *"), "Acme Climate");
    await user.type(
      screen.getByLabelText("apply.contactEmail *"),
      "hello@acme.org",
    );
    await user.type(
      screen.getByLabelText("apply.walletAddress *"),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));

    // Project step
    await waitFor(() => {
      expect(screen.getByText("apply.stepProject")).toBeTruthy();
    });
    await user.type(screen.getByLabelText("apply.projectName *"), "Acme Solar");
    await user.type(
      screen.getByLabelText("apply.projectLocation *"),
      "Nairobi",
    );
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));

    // Impact step
    await waitFor(() => {
      expect(screen.getByText("apply.stepImpact")).toBeTruthy();
    });
    await user.type(screen.getByLabelText("apply.co2PerXLM *"), "0.05");
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));

    // Documents step — skip uploading, just go next
    await waitFor(() => {
      expect(screen.getByText("apply.documentsTitle")).toBeTruthy();
    });
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));

    // Review step
    await waitFor(() => {
      expect(screen.getByText("apply.stepReview")).toBeTruthy();
    });
    expect(screen.getByText("Acme Climate")).toBeTruthy();
    expect(screen.getByText("Acme Solar")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: SUBMIT_BTN }));

    await waitFor(() => {
      expect(screen.getByText("apply.subThanks")).toBeTruthy();
    });
    expect(mockSubmit).toHaveBeenCalledTimes(1);
    const submitted = mockSubmit.mock.calls[0][0];
    expect(submitted.organizationName).toBe("Acme Climate");
    expect(submitted.projectName).toBe("Acme Solar");
    expect(submitted.co2PerXLM).toBe("0.05");
    expect(submitted.supportingDocuments).toEqual([]);
  });

  test("uploads a file via api.ts.uploadSupportingDocument", async () => {
    mockUpload.mockResolvedValueOnce({
      key: "k1",
      url: "/api/uploads/k1",
      size: 1234,
      contentType: "application/pdf",
      backend: "local",
      originalName: "methodology.pdf",
    });
    render(<ApplyPage />);
    const user = userEvent.setup();

    // Forward to Documents step.
    await user.type(screen.getByLabelText("apply.orgName *"), "Acme Climate");
    await user.type(
      screen.getByLabelText("apply.contactEmail *"),
      "hello@acme.org",
    );
    await user.type(
      screen.getByLabelText("apply.walletAddress *"),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));
    await user.type(screen.getByLabelText("apply.projectName *"), "Acme Solar");
    await user.type(
      screen.getByLabelText("apply.projectLocation *"),
      "Nairobi",
    );
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));
    await user.type(screen.getByLabelText("apply.co2PerXLM *"), "0.05");
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));

    const fileInput = screen.getByLabelText(
      "apply.documentsTitle",
    ) as HTMLInputElement;
    const fake = new FakeFile("methodology.pdf", 1234, "application/pdf");
    fireEvent.change(fileInput, { target: { files: [fake] } });

    await waitFor(() => {
      expect(mockUpload).toHaveBeenCalledWith(fake);
    });
    await waitFor(() => {
      expect(screen.getByText("methodology.pdf")).toBeTruthy();
    });
  });

  test("rejects server error messages gracefully", async () => {
    mockSubmit.mockRejectedValueOnce({
      response: { data: { error: "Backend failed. Please retry." } },
    });

    render(<ApplyPage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText("apply.orgName *"), "Acme Climate");
    await user.type(
      screen.getByLabelText("apply.contactEmail *"),
      "hello@acme.org",
    );
    await user.type(
      screen.getByLabelText("apply.walletAddress *"),
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    );
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));
    await user.type(screen.getByLabelText("apply.projectName *"), "Acme Solar");
    await user.type(
      screen.getByLabelText("apply.projectLocation *"),
      "Nairobi",
    );
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));
    await user.type(screen.getByLabelText("apply.co2PerXLM *"), "0.05");
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));
    await user.click(screen.getByRole("button", { name: NEXT_BTN }));
    await user.click(screen.getByRole("button", { name: SUBMIT_BTN }));

    await waitFor(() => {
      expect(
        screen.getByText("Backend failed. Please retry."),
      ).toBeTruthy();
    });
  });

  test("shows real-time validation errors on field blur", async () => {
    render(<ApplyPage />);

    const contactEmailInput = screen.getByLabelText("apply.contactEmail *");
    await userEvent.type(contactEmailInput, "bad-email");
    fireEvent.blur(contactEmailInput);

    // With mode: "onTouched", errors appear after blur
    await waitFor(() => {
      const alerts = screen.getAllByRole("alert");
      const messages = alerts.map((a) => a.textContent).join(" ");
      expect(messages).toMatch(/Invalid/i);
    });
  });
});
