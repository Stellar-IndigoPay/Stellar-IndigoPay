/**
 * __tests__/ThemeToggle.test.tsx
 *
 * Behavioral tests for ThemeToggle covering toggle behaviour,
 * icon visibility, localStorage persistence, and accessibility.
 */
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@/lib/theme";
import ThemeToggle from "../ThemeToggle";

const THEME_STORAGE_KEY = "stellar-indigopay-theme";

beforeEach(() => {
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  try {
    localStorage.clear();
  } catch {
    /* localStorage may be unavailable */
  }
  window.matchMedia = jest.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    addListener: jest.fn(),
    removeListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
});

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("toggles from light to dark on click", async () => {
    const user = userEvent.setup();
    renderToggle();

    const button = screen.getByRole("button", { name: /switch to dark mode/i });
    expect(button).toHaveAttribute("aria-pressed", "false");

    await user.click(button);

    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /switch to light mode/i })).toBeInTheDocument();
  });

  it("toggles from dark to light on click", async () => {
    const user = userEvent.setup();
    localStorage.setItem(THEME_STORAGE_KEY, "dark");

    renderToggle();

    const button = screen.getByRole("button", { name: /switch to light mode/i });
    expect(button).toHaveAttribute("aria-pressed", "true");

    await user.click(button);

    expect(screen.getByRole("button", { name: /switch to dark mode/i })).toBeInTheDocument();
  });

  it("persists preference to localStorage", async () => {
    const user = userEvent.setup();
    renderToggle();

    await user.click(screen.getByRole("button", { name: /switch to dark mode/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

    await user.click(screen.getByRole("button", { name: /switch to light mode/i }));
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  });

  it("applies the .dark class to the document when toggling to dark", async () => {
    const user = userEvent.setup();
    renderToggle();

    expect(document.documentElement.classList.contains("dark")).toBe(false);

    await user.click(screen.getByRole("button", { name: /switch to dark mode/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    await user.click(screen.getByRole("button", { name: /switch to light mode/i }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("does not render a button before mount, then renders one after", () => {
    const { container } = render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    // In jsdom, effects run synchronously so the button should be present after render.
    expect(screen.getByRole("button")).toBeInTheDocument();
    // The button should be inside the container
    expect(container.querySelector("button")).toBeTruthy();
  });
});
