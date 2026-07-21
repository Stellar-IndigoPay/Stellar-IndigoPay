/**
 * __tests__/VerificationTable.test.tsx — Unit tests for VerificationTable component
 *
 * Covers: rendering with mock data, loading state, empty state, error state,
 * status badges, and action button click.
 *
 * @jest-environment jsdom
 */
import { render, screen, fireEvent } from "@testing-library/react";
import VerificationTable from "@/components/admin/VerificationTable";
import VerificationFilters from "@/components/admin/VerificationFilters";
import type { VerificationRequestResponse } from "@/lib/api";

// Mock next/router
jest.mock("next/router", () => ({
  useRouter: () => ({ push: jest.fn(), query: {}, pathname: "" }),
}));

// For Link navigation, just render children
jest.mock("next/link", () => {
  // eslint-disable-next-line react/display-name
  return ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  );
});

const MOCK_REQUESTS: VerificationRequestResponse[] = [
  {
    id: "req-1",
    organizationName: "Green Earth Foundation",
    organizationWebsite: "https://greenearth.org",
    organizationCountry: "Kenya",
    contactEmail: "info@greenearth.org",
    walletAddress: "GC5MNM5V3HJKKZ6YZ5TKB7Q3XLWOFJ5QZ6H5T5IZ7G3E5YFWH3VNKGPA",
    projectName: "Reforest Kenya Phase 2",
    projectCategory: "Reforestation",
    projectLocation: "Nairobi, Kenya",
    projectDescription: "A reforestation project in Kenya.",
    co2PerXLM: "0.05",
    expectedAnnualTonnesCO2: "1200",
    supportingDocuments: [
      { name: "Project Plan.pdf", url: "/api/uploads/plan.pdf", size: 204800 },
    ],
    storageBackend: "local",
    notes: "Urgent review needed",
    status: "pending",
    reviewerNotes: null,
    reviewedBy: null,
    submittedAt: "2026-07-10T08:00:00.000Z",
    reviewedAt: null,
    reviewTimeline: "5–10 business days",
  },
  {
    id: "req-2",
    organizationName: "Solar Future Inc",
    organizationWebsite: "https://solarfuture.io",
    organizationCountry: "India",
    contactEmail: "hello@solarfuture.io",
    walletAddress: "GBD6LJ7KZ5TKB7Q3XLWOFJ5QZ6H5T5IZ7G3E5YFWH3VNKGPABCDE",
    projectName: "Solar Microgrid Rajasthan",
    projectCategory: "Solar Energy",
    projectLocation: "Rajasthan, India",
    projectDescription: "Solar microgrid for rural communities.",
    co2PerXLM: "0.03",
    expectedAnnualTonnesCO2: "800",
    supportingDocuments: [],
    storageBackend: "local",
    notes: null,
    status: "in_review",
    reviewerNotes: "Looks promising, need more details",
    reviewedBy: "admin",
    submittedAt: "2026-07-08T10:30:00.000Z",
    reviewedAt: "2026-07-14T14:00:00.000Z",
    reviewTimeline: "5–10 business days",
  },
  {
    id: "req-3",
    organizationName: "Ocean Guardians",
    organizationWebsite: null,
    organizationCountry: null,
    contactEmail: "team@oceanguardians.org",
    walletAddress: "GC5MNM5V3HJKKZ6YZ5TKB7Q3XLWOFJ5QZ6H5T5IZ7G3E5YFWH3VNKGPA",
    projectName: "Coral Reef Restoration",
    projectCategory: "Ocean Conservation",
    projectLocation: "Great Barrier Reef",
    projectDescription: null,
    co2PerXLM: "0.02",
    expectedAnnualTonnesCO2: null,
    supportingDocuments: [],
    storageBackend: "local",
    notes: null,
    status: "approved",
    reviewerNotes: "Approved after review",
    reviewedBy: "admin",
    submittedAt: "2026-07-01T12:00:00.000Z",
    reviewedAt: "2026-07-12T09:00:00.000Z",
    reviewTimeline: "5–10 business days",
  },
];

describe("VerificationTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Loading state ──────────────────────────────────────────────

  it("renders loading skeleton when loading is true", () => {
    const { container } = render(
      <VerificationTable requests={[]} loading={true} />,
    );
    // Should show 5 skeleton rows (animate-pulse)
    const skeletons = container.querySelectorAll(".animate-pulse");
    expect(skeletons.length).toBe(5);
  });

  // ── Error state ────────────────────────────────────────────────

  it("renders error message when error prop is set", () => {
    render(
      <VerificationTable
        requests={[]}
        error="Failed to fetch verification requests"
      />,
    );
    expect(screen.getByText("Failed to load requests")).toBeInTheDocument();
    expect(
      screen.getByText("Failed to fetch verification requests"),
    ).toBeInTheDocument();
  });

  // ── Empty state ────────────────────────────────────────────────

  it("renders empty state when requests array is empty", () => {
    render(<VerificationTable requests={[]} />);
    expect(
      screen.getByText("No verification requests match your filters"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Adjust the status filter to see more requests/),
    ).toBeInTheDocument();
  });

  // ── Renders table with data ────────────────────────────────────

  it("renders all request rows with correct data", () => {
    render(<VerificationTable requests={MOCK_REQUESTS} />);

    // Check organization names
    expect(screen.getByText("Green Earth Foundation")).toBeInTheDocument();
    expect(screen.getByText("Solar Future Inc")).toBeInTheDocument();
    expect(screen.getByText("Ocean Guardians")).toBeInTheDocument();

    // Check project names (with emoji icons)
    expect(screen.getByText(/Reforest Kenya Phase 2/)).toBeInTheDocument();
    expect(screen.getByText(/Solar Microgrid Rajasthan/)).toBeInTheDocument();
    expect(screen.getByText(/Coral Reef Restoration/)).toBeInTheDocument();

    // Check status badges
    expect(screen.getByText("Pending")).toBeInTheDocument();
    expect(screen.getByText("In Review")).toBeInTheDocument();
    expect(screen.getByText("Approved")).toBeInTheDocument();

    // Check country names
    expect(screen.getByText("Kenya")).toBeInTheDocument();
    expect(screen.getByText("India")).toBeInTheDocument();
  });

  it("supports sortable columns and shows the active sort indicator", () => {
    const { container } = render(<VerificationTable requests={MOCK_REQUESTS} />);

    const submittedSortButton = screen.getByRole("button", {
      name: /sort by submitted/i,
    });
    expect(submittedSortButton).toBeInTheDocument();

    fireEvent.click(submittedSortButton);

    expect(submittedSortButton).toHaveAttribute(
      "aria-label",
      "Sort by Submitted",
    );
    expect(
      screen.getByRole("columnheader", { name: /submitted/i }),
    ).toHaveAttribute("aria-sort", "ascending");
    expect(container.querySelector("tbody tr:first-child")).toHaveTextContent(
      "Ocean Guardians",
    );
  });

  it("renders pagination controls when page metadata is provided", () => {
    render(
      <VerificationTable
        requests={MOCK_REQUESTS}
        page={2}
        pageSize={10}
        totalCount={45}
        onPageChange={jest.fn()}
        onPageSizeChange={jest.fn()}
      />,
    );

    expect(screen.getByText("Showing 11-20 of 45")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /previous/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /next/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /page size/i })).toBeInTheDocument();
  });

  it("renders a filter bar that updates the selected status", () => {
    const onChange = jest.fn();
    render(<VerificationFilters value="pending" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Approved" }));
    expect(onChange).toHaveBeenCalledWith("approved");
  });

  // ── Status badges have correct colors ──────────────────────────

  it("renders status badges with appropriate color classes", () => {
    render(<VerificationTable requests={MOCK_REQUESTS} />);

    const pending = screen.getByText("Pending");
    const inReview = screen.getByText("In Review");
    const approved = screen.getByText("Approved");

    // Pending should be amber
    expect(pending.className).toContain("amber");
    // In review should be blue
    expect(inReview.className).toContain("blue");
    // Approved should be emerald
    expect(approved.className).toContain("emerald");
  });

  // ── "Start Review" button click ────────────────────────────────

  it("calls onStartReview when Start Review button is clicked", () => {
    const onStartReview = jest.fn();
    render(
      <VerificationTable
        requests={MOCK_REQUESTS}
        onStartReview={onStartReview}
      />,
    );

    // Only pending requests should show "Start Review"
    // req-2 is in_review, req-3 is approved - only req-1 is pending
    const startReviewBtns = screen.getAllByText("Start Review");
    expect(startReviewBtns.length).toBe(1);

    fireEvent.click(startReviewBtns[0]);
    expect(onStartReview).toHaveBeenCalledWith("req-1");
  });

  // ── "View Details" links ───────────────────────────────────────

  it("renders View Details links pointing to detail page", () => {
    render(<VerificationTable requests={MOCK_REQUESTS} />);

    const viewDetailsLinks = screen.getAllByText("View Details");
    expect(viewDetailsLinks.length).toBe(3);

    // Each link should point to the correct detail page
    expect(viewDetailsLinks[0].closest("a")).toHaveAttribute(
      "href",
      "/admin/verification/req-1",
    );
    expect(viewDetailsLinks[1].closest("a")).toHaveAttribute(
      "href",
      "/admin/verification/req-2",
    );
    expect(viewDetailsLinks[2].closest("a")).toHaveAttribute(
      "href",
      "/admin/verification/req-3",
    );
  });

  // ── Hide actions column ────────────────────────────────────────

  it("hides action buttons when hideActions is true", () => {
    render(
      <VerificationTable requests={MOCK_REQUESTS} hideActions={true} />,
    );

    expect(screen.queryByText("Start Review")).not.toBeInTheDocument();
    expect(screen.queryByText("View Details")).not.toBeInTheDocument();
  });
});
