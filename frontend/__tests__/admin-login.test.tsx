/**
 * __tests__/admin-login.test.tsx — Unit tests for admin login page
 *
 * Covers: form rendering, input validation, submission flow, error display,
 * and redirect on success.
 *
 * @jest-environment jsdom
 */
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const mockPush = jest.fn();
jest.mock("next/router", () => ({
  useRouter: () => ({
    push: mockPush,
    query: {},
    pathname: "/admin/login",
    replace: mockPush,
  }),
}));

// Mock adminAuth
const mockAdminLogin = jest.fn();
jest.mock("@/lib/adminAuth", () => ({
  adminLogin: (...args: unknown[]) => mockAdminLogin(...args),
  isAdminAuthenticated: () => false,
}));

// Mock ThemeToggle
jest.mock("@/components/ThemeToggle", () => ({
  __esModule: true,
  default: () => <button data-testid="theme-toggle">Toggle Theme</button>,
}));

describe("Admin Login Page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── Initial render ─────────────────────────────────────────────

  it("renders the login form with username, password, and submit button", () => {
    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    expect(screen.getByText("Admin Login")).toBeInTheDocument();
    expect(
      screen.getByText("Sign in to manage verification requests"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Username")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign In" })).toBeInTheDocument();
  });

  // ── Validation: empty fields ───────────────────────────────────

  it("shows error when submitting with empty fields", async () => {
    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const submitBtn = screen.getByRole("button", { name: "Sign In" });
    fireEvent.click(submitBtn);

    expect(screen.getByText("Username is required")).toBeInTheDocument();
    expect(mockAdminLogin).not.toHaveBeenCalled();
  });

  it("shows error when username is filled but password is empty", async () => {
    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "admin");
    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    expect(screen.getByText("Password is required")).toBeInTheDocument();
    expect(mockAdminLogin).not.toHaveBeenCalled();
  });

  // ── Successful submission ──────────────────────────────────────

  it("calls adminLogin and redirects on successful submission", async () => {
    mockAdminLogin.mockResolvedValue({
      token: "test-token",
      refreshToken: "test-refresh",
      expiresIn: 3600,
    });

    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "correct-password");

    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(mockAdminLogin).toHaveBeenCalledWith("admin", "correct-password");
      expect(mockPush).toHaveBeenCalledWith("/admin/verification");
    });
  });

  // ── Failed submission ──────────────────────────────────────────

  it("displays error message when login fails", async () => {
    mockAdminLogin.mockRejectedValue(
      new Error("Invalid credentials"),
    );

    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong-password");

    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(
        screen.getByText("Invalid credentials"),
      ).toBeInTheDocument();
    });

    // Should NOT redirect
    expect(mockPush).not.toHaveBeenCalled();
  });

  it("displays default error message when login fails with no error message", async () => {
    mockAdminLogin.mockRejectedValue(new Error(""));

    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong");

    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(
        screen.getByText("Login failed. Please check your credentials."),
      ).toBeInTheDocument();
    });
  });

  // ── Clear error on input change ────────────────────────────────

  it("clears error when user starts typing again", async () => {
    mockAdminLogin.mockRejectedValue(
      new Error("Invalid credentials"),
    );

    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Username"), "admin");
    await user.type(screen.getByLabelText("Password"), "wrong");

    fireEvent.click(screen.getByRole("button", { name: "Sign In" }));

    await waitFor(() => {
      expect(screen.getByText("Invalid credentials")).toBeInTheDocument();
    });

    // Start typing - error should clear
    await user.type(screen.getByLabelText("Username"), "x");
    expect(screen.queryByText("Invalid credentials")).not.toBeInTheDocument();
  });

  // ── Back to home link ──────────────────────────────────────────

  it("renders a back-to-home link", () => {
    const AdminLoginPage = require("@/pages/admin/login").default;
    render(<AdminLoginPage />);

    const backLink = screen.getByText("← Back to home");
    expect(backLink).toBeInTheDocument();
    expect(backLink.closest("a")).toHaveAttribute("href", "/");
  });
});
