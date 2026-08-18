/**
 * hooks/useFocusTrap.ts
 *
 * Reusable hook that traps keyboard focus inside a container element while
 * `active` is true. Used by every modal/dialog so they satisfy WCAG 2.4.3
 * (Focus Order) and WAI-ARIA Authoring Practices for dialogs.
 *
 * Behavior:
 *  • Tab / Shift+Tab cycles through the container's focusable descendants.
 *  • Esc fires `onEscape()` (parental owner typically closes the dialog).
 *  • On mount, focus moves to the first focusable element inside the
 *    container (or to the container itself if none are focusable).
 *  • On unmount, focus returns to the element that opened the dialog so the
 *    user's place in the document is preserved.
 *
 * The hook deliberately does **not** assume container geometry — it pushes
 * and restores `document.body.style.overflow` itself only when the caller
 * wires up scroll lock separately (existing modals already do).
 */
import { useEffect, useRef, type RefObject } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type=\"hidden\"])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export function getFocusableElements(
  container: HTMLElement,
): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
  ).filter(
    (el) =>
      !el.hasAttribute("aria-hidden") &&
      el.offsetParent !== null &&
      getComputedStyle(el).visibility !== "hidden",
  );
}

interface UseFocusTrapOptions {
  /** Whether the trap is currently engaged. */
  active: boolean;
  /** Fired when the user presses Escape while the trap is active. */
  onEscape?: () => void;
  /**
   * Optional override: if provided, focus is moved to this element when the
   * trap activates instead of the first focusable descendant.
   */
  initialFocusRef?: RefObject<HTMLElement>;
}

export function useFocusTrap<T extends HTMLElement = HTMLElement>({
  active,
  onEscape,
  initialFocusRef,
}: UseFocusTrapOptions): RefObject<T> {
  const containerRef = useRef<T>(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Remember which element had focus so we can restore it on close.
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus into the trap.
    const focusTarget =
      initialFocusRef?.current ??
      getFocusableElements(container)[0] ??
      container;
    // Defer to the next frame so layout-driven focusables (e.g. mounted
    // children) are present.
    const focusTargetId = window.setTimeout(() => {
      if (focusTarget && typeof (focusTarget as HTMLElement).focus === "function") {
        (focusTarget as HTMLElement).focus();
      }
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (onEscape) {
          event.preventDefault();
          onEscape();
        }
        return;
      }

      if (event.key !== "Tab") return;
      const focusables = getFocusableElements(container);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeEl = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (activeEl === last || !container.contains(activeEl)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);

    return () => {
      window.clearTimeout(focusTargetId);
      document.removeEventListener("keydown", handleKeyDown);
      // Restore focus to whatever opened the dialog.
      previouslyFocused?.focus?.();
    };
  }, [active, onEscape, initialFocusRef]);

  return containerRef;
}
