/**
 * components/Tabs.tsx
 *
 * Reusable WAI-ARIA 1.1 Tab Pattern implementation extracted from
 * `pages/dashboard.tsx`. Provides a single-source-of-truth for tab UI across
 * the app so that the keyboard pattern, focus management, and ARIA wiring are
 * uniform and unit-testable in isolation.
 *
 * Behavior:
 *  • Wraps a configurable list of tabs (`tabs`) in a role="tablist".
 *  • Each tab is a button with role="tab", aria-selected, aria-controls,
 *    roving tabIndex (only the active tab is tabIndex=0; siblings are -1).
 *  • The active panel is rendered with role="tabpanel" and aria-labelledby
 *    pointing at its tab id.
 *  • Keyboard navigation:
 *        ArrowRight → next tab (wraps)
 *        ArrowLeft  → previous tab (wraps)
 *        Home       → first tab
 *        End        → last tab
 *    The newly-selected tab receives focus so screen-readers announce it.
 */
import {
  useCallback,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

export interface TabItem {
  /** Stable identifier. Used to derive DOM ids and the active state. */
  id: string;
  /** What the user clicks. May include inline nodes (badges, icons). */
  label: ReactNode;
  /** Panel content. Rendered only when this tab is active. */
  content: ReactNode;
}

export interface TabsProps {
  /** Ordered list of tabs to render. Order drives left/right cycling. */
  tabs: TabItem[];
  /** Active tab id. When provided the component is fully controlled. */
  value?: string;
  /** Default active tab on first render. Ignored when `value` is provided. */
  defaultValue?: string;
  /** Accessible label for the tablist container. */
  ariaLabel: string;
  /** Fired whenever the selected tab changes (mouse or keyboard). */
  onChange?: (id: string) => void;
}

export default function Tabs({
  tabs,
  value,
  defaultValue,
  ariaLabel,
  onChange,
}: TabsProps) {
  const isControlled = value !== undefined;
  const [internalValue, setInternalValue] = useState<string>(
    defaultValue ?? tabs[0]?.id ?? "",
  );
  const activeId = isControlled ? (value as string) : internalValue;

  const setActive = useCallback(
    (id: string) => {
      if (!isControlled) setInternalValue(id);
      onChange?.(id);
    },
    [isControlled, onChange],
  );

  // Map of tab id → button element, used to move focus on keyboard nav.
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const setTabRef = useCallback(
    (id: string) => (node: HTMLButtonElement | null) => {
      if (node) tabRefs.current.set(id, node);
      else tabRefs.current.delete(id);
    },
    [],
  );

  // Stable ids for the tab/panel DOM nodes (SSR-safe via useId).
  const baseId = useId();
  const tabId = (id: string) => `tab-${baseId}-${id}`;
  const panelId = (id: string) => `tabpanel-${baseId}-${id}`;

  const activeIndex = tabs.findIndex((t) => t.id === activeId);
  // Defensive fallback if activeId is invalid; snap to first tab.
  const safeIndex = activeIndex >= 0 ? activeIndex : 0;
  const safeActiveId = tabs[safeIndex]?.id ?? "";

  const handleKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentId: string,
  ) => {
    const idx = tabs.findIndex((t) => t.id === currentId);
    if (idx < 0) return;
    let nextIdx: number | null = null;
    switch (event.key) {
      case "ArrowRight":
        nextIdx = (idx + 1) % tabs.length;
        break;
      case "ArrowLeft":
        nextIdx = (idx - 1 + tabs.length) % tabs.length;
        break;
      case "Home":
        nextIdx = 0;
        break;
      case "End":
        nextIdx = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIdx];
    setActive(nextTab.id);
    // Focus the newly-selected tab so screen-readers announce the change.
    tabRefs.current.get(nextTab.id)?.focus();
  };

  return (
    <>
      <div
        role="tablist"
        aria-label={ariaLabel}
        className="flex border-b border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] mb-6"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === safeActiveId;
          return (
            <button
              key={tab.id}
              ref={setTabRef(tab.id)}
              role="tab"
              type="button"
              id={tabId(tab.id)}
              aria-selected={isActive}
              aria-controls={panelId(tab.id)}
              tabIndex={isActive ? 0 : -1}
              onClick={() => setActive(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, tab.id)}
              className={`px-6 py-3 text-sm font-semibold transition-all border-b-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0A0A1A] flex items-center gap-2 ${
                isActive
                  ? "border-[#4F46E5] dark:border-[#818CF8] text-[#0F172A] dark:text-[#E2E8F0]"
                  : "border-transparent text-[#64748B] dark:text-[#94A3B8] hover:text-[#4F46E5] dark:hover:text-[#818CF8]"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {tabs.map((tab) => {
        if (tab.id !== safeActiveId) return null;
        return (
          <div
            key={tab.id}
            role="tabpanel"
            id={panelId(tab.id)}
            aria-labelledby={tabId(tab.id)}
            tabIndex={0}
            className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0A0A1A]"
          >
            {tab.content}
          </div>
        );
      })}
    </>
  );
}
