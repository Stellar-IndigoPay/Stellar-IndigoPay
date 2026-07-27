import { useEffect } from "react";

export interface Shortcut {
  key: string;
  ctrl?: boolean;
  meta?: boolean;
  handler: () => void;
  description: string;
}

export default function useShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Prefer the composed path to correctly identify elements inside Shadow DOM.
      const path = (e as any).composedPath ? (e as any).composedPath() : null;
      const target = (path && path.length ? path[0] : e.target) as EventTarget | null;

      // Check if target is an Element before invoking Element-specific APIs.
      if (target instanceof Element) {
        const el = target as HTMLElement;
        const tag = (el.tagName || "").toLowerCase();
        
        const isEditable =
          tag === "input" ||
          tag === "textarea" ||
          el.isContentEditable ||
          el.contentEditable === "true" ||
          (typeof el.getAttribute === "function" &&
            el.getAttribute("contenteditable") === "true");

        if (isEditable) {
          return;
        }
      }

      for (const shortcut of shortcuts) {
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();
        
        let modifierMatch = false;
        if (shortcut.meta && shortcut.ctrl) {
          modifierMatch = e.ctrlKey && e.metaKey;
        } else if (shortcut.meta) {
          modifierMatch = e.metaKey || e.ctrlKey; // Cmd on Mac, Ctrl on Win/Linux
        } else if (shortcut.ctrl) {
          modifierMatch = e.ctrlKey || e.metaKey; // Ctrl on Win/Linux, Cmd on Mac
        } else {
          modifierMatch = !e.ctrlKey && !e.metaKey;
        }

        if (keyMatch && modifierMatch) {
          e.preventDefault();
          shortcut.handler();
          return;
        }
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
