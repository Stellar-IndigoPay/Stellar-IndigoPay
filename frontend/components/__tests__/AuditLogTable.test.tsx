import { render, screen, fireEvent } from "@testing-library/react";
import AuditLogTable, {
  type AuditLogEntry,
  type AuditLogFilters,
  DEFAULT_FILTERS,
} from "../admin/AuditLogTable";

// ── Mock data ─────────────────────────────────────────────────────────────────

const mockEntries: AuditLogEntry[] = [
  {
    id: "1",
    actor: "admin-user",
    action: "admin.login",
    target_type: null,
    target_id: null,
    metadata: '{"method":"POST","path":"/api/admin/login","statusCode":200}',
    ip_address: "192.168.1.1",
    created_at: "2026-07-16T10:00:00.000Z",
  },
  {
    id: "2",
    actor: "admin-user",
    action: "verification.approved",
    target_type: "verification_request",
    target_id: "vr-123",
    metadata: '{"reason":"All documents verified","reviewer":"admin"}',
    ip_address: "192.168.1.1",
    created_at: "2026-07-16T11:00:00.000Z",
  },
  {
    id: "3",
    actor: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    action: "project.register",
    target_type: "project",
    target_id: "proj-456",
    metadata: { name: "Amazon Reforestation", category: "Reforestation" },
    ip_address: "10.0.0.1",
    created_at: "2026-07-15T09:00:00.000Z",
  },
];

const defaultProps = {
  logs: mockEntries,
  total: 100,
  page: 1,
  pageSize: 50,
  loading: false,
  filters: DEFAULT_FILTERS,
  onFilterChange: jest.fn(),
  onPageChange: jest.fn(),
  onExport: jest.fn(),
  distinctActions: [
    "admin.login",
    "admin.logout",
    "verification.approved",
    "verification.rejected",
    "project.register",
    "project.deactivate",
  ],
};

describe("AuditLogTable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders audit log entries in the table", () => {
    render(<AuditLogTable {...defaultProps} />);

    expect(screen.getByText("admin.login")).toBeInTheDocument();
    expect(screen.getByText("verification.approved")).toBeInTheDocument();
    expect(screen.getByText("project.register")).toBeInTheDocument();
  });

  it("shows total entry count and pagination info", () => {
    render(<AuditLogTable {...defaultProps} />);

    expect(screen.getByText(/Showing/)).toBeInTheDocument();
    expect(screen.getByText(/100/)).toBeInTheDocument();
    expect(screen.getByText(/1–50/)).toBeInTheDocument();
  });

  it("renders filter inputs", () => {
    render(<AuditLogTable {...defaultProps} />);

    expect(screen.getByLabelText("Actor")).toBeInTheDocument();
    expect(screen.getByLabelText("Action")).toBeInTheDocument();
    expect(screen.getByLabelText("Target")).toBeInTheDocument();
    expect(screen.getByLabelText("Search")).toBeInTheDocument();
    expect(screen.getByLabelText("From")).toBeInTheDocument();
    expect(screen.getByLabelText("To")).toBeInTheDocument();
  });

  it("calls onFilterChange when actor input changes", () => {
    render(<AuditLogTable {...defaultProps} />);

    const actorInput = screen.getByLabelText("Actor");
    fireEvent.change(actorInput, { target: { value: "admin" } });

    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ actor: "admin" }),
    );
  });

  it("calls onFilterChange when action dropdown changes", () => {
    render(<AuditLogTable {...defaultProps} />);

    const actionSelect = screen.getByLabelText("Action");
    fireEvent.change(actionSelect, { target: { value: "admin.login" } });

    expect(defaultProps.onFilterChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: "admin.login" }),
    );
  });

  it("calls onExport when export button is clicked", () => {
    render(<AuditLogTable {...defaultProps} />);

    const exportButton = screen.getByLabelText("Export audit log as CSV");
    fireEvent.click(exportButton);

    expect(defaultProps.onExport).toHaveBeenCalledTimes(1);
  });

  it("disables export button when logs are empty", () => {
    render(<AuditLogTable {...defaultProps} logs={[]} total={0} />);

    const exportButton = screen.getByLabelText("Export audit log as CSV");
    expect(exportButton).toBeDisabled();
  });

  it("calls onPageChange when pagination buttons are clicked", () => {
    render(<AuditLogTable {...defaultProps} />);

    const nextButton = screen.getByText("Next →");
    fireEvent.click(nextButton);

    expect(defaultProps.onPageChange).toHaveBeenCalledWith(2);
  });

  it("disables Previous button on page 1", () => {
    render(<AuditLogTable {...defaultProps} />);

    const prevButton = screen.getByText("← Previous");
    expect(prevButton).toBeDisabled();
  });

  it("shows loading skeleton when loading", () => {
    const { container } = render(
      <AuditLogTable {...defaultProps} loading={true} />,
    );

    // Should show animated pulse skeleton rows instead of table
    const pulseElements = container.querySelectorAll(".animate-pulse");
    expect(pulseElements.length).toBeGreaterThan(0);
  });

  it("shows error state when error is provided", () => {
    render(
      <AuditLogTable
        {...defaultProps}
        error="Connection failed"
        logs={[]}
        total={0}
      />,
    );

    expect(screen.getByText("Failed to load audit log")).toBeInTheDocument();
    expect(screen.getByText("Connection failed")).toBeInTheDocument();
  });

  it("shows empty state when no entries match", () => {
    render(<AuditLogTable {...defaultProps} logs={[]} total={0} />);

    expect(
      screen.getByText("No audit log entries"),
    ).toBeInTheDocument();
  });

  it("shows 'Clear filters' in empty state when filters are active", () => {
    const activeFilters: AuditLogFilters = {
      ...DEFAULT_FILTERS,
      actor: "admin",
    };
    render(
      <AuditLogTable
        {...defaultProps}
        logs={[]}
        total={0}
        filters={activeFilters}
      />,
    );

    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });

  it("renders distinct action options in the dropdown", () => {
    render(<AuditLogTable {...defaultProps} />);

    const actionSelect = screen.getByLabelText("Action");
    const options = Array.from(actionSelect.querySelectorAll("option"));
    const optionValues = options.map((o) => (o as HTMLOptionElement).value);

    expect(optionValues).toContain("admin.login");
    expect(optionValues).toContain("verification.approved");
    expect(optionValues).toContain("project.register");
  });

  it("shows Metadata popover when Details is clicked", () => {
    render(<AuditLogTable {...defaultProps} />);

    const detailsButtons = screen.getAllByLabelText("View metadata");
    fireEvent.click(detailsButtons[0]);

    // After clicking, should see "Hide" label instead
    expect(screen.getByLabelText("Close metadata")).toBeInTheDocument();
  });
});
