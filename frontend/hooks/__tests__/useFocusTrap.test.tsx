/**
 * hooks/__tests__/useFocusTrap.test.tsx
 *
 * Validates the focus trap implementation: focus moves into the trap on
 * mount, Tab cycles through focusables, Shift+Tab reverses, and Escape
 * invokes the provided onEscape callback.
 */
import { useRef } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFocusTrap } from "../useFocusTrap";

function TrapHarness({
  active = true,
  onEscape,
}: {
  active?: boolean;
  onEscape?: () => void;
}) {
  const containerRef = useFocusTrap<HTMLDivElement>({ active, onEscape });
  return (
    <div ref={containerRef}>
      <button>First</button>
      <button>Middle</button>
      <button>Last</button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("focuses the first focusable element when the trap activates", async () => {
    render(<TrapHarness active />);
    // Allow the deferred focus to fire (the hook uses setTimeout(..., 0)).
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("Tab on the last element wraps to the first", async () => {
    const user = userEvent.setup();
    render(<TrapHarness active />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await user.tab(); // First → Middle
    await user.tab(); // Middle → Last
    await user.tab(); // Last → wraps to First
    expect(screen.getByRole("button", { name: "First" })).toHaveFocus();
  });

  it("Shift+Tab on the first element wraps to the last", async () => {
    const user = userEvent.setup();
    render(<TrapHarness active />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "Last" })).toHaveFocus();
  });

  it("invokes onEscape when the user presses Escape", async () => {
    const onEscape = jest.fn();
    const user = userEvent.setup();
    render(<TrapHarness active onEscape={onEscape} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    await user.keyboard("{Escape}");
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when active is false", async () => {
    render(<TrapHarness active={false} />);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // No focus should be moved into the trap while inactive.
    expect(document.body).toHaveFocus();
  });
});
