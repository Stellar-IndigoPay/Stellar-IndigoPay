/**
 * components/ToastNotification.tsx
 * Lightweight toast notifications (no external library).
 */
import { useEffect, useMemo, useState } from "react";

export type ToastItem = {
  id: string;
  title: string;
  description?: string;
  createdAt: number;
};

export default function ToastNotification({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  const [exiting, setExiting] = useState<Set<string>>(new Set());

  const sorted = useMemo(
    () => [...toasts].sort((a, b) => a.createdAt - b.createdAt),
    [toasts],
  );

  useEffect(() => {
    if (sorted.length === 0) return;
    const timers: number[] = [];

    for (const toast of sorted) {
      // Begin exit a bit before removal so the slide-down animation plays.
      timers.push(
        window.setTimeout(() => {
          setExiting((prev) => new Set(prev).add(toast.id));
        }, 3600),
      );

      timers.push(
        window.setTimeout(() => {
          onDismiss(toast.id);
          setExiting((prev) => {
            const next = new Set(prev);
            next.delete(toast.id);
            return next;
          });
        }, 4000),
      );
    }

    return () => {
      timers.forEach((t) => window.clearTimeout(t));
    };
  }, [sorted, onDismiss]);

  if (sorted.length === 0) return null;

  return (
    <div
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] w-[min(92vw,420px)] space-y-2 pointer-events-none"
      role="region"
      aria-label="Notifications"
    >
      {/* Visually hidden aggregate live region so screen readers announce
          a summary for the newest toast. We key the <p> on the newest toast
          id so the live region’s content actually changes for each new
          notification — a stable string would not re-announce. */}
      <p
        key={sorted[0]?.id ?? "empty"}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {sorted.length > 0
          ? `Notification: ${sorted[0].title}${
              sorted[0].description ? ` — ${sorted[0].description}` : ""
            }`
          : ""}
      </p>
      {sorted.map((t) => {
        const isExiting = exiting.has(t.id);
        return (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-2xl border border-[rgba(99,102,241,0.12)] dark:border-[rgba(129,140,248,0.15)] bg-white/95 dark:bg-[#14142D]/95 backdrop-blur shadow-lg px-4 py-3 transition-all duration-300 ${
              isExiting
                ? "opacity-0 translate-y-2"
                : "opacity-100 translate-y-0"
            }`}
            role="status"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-xl bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] flex items-center justify-center text-lg flex-shrink-0">
                🍃
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] text-sm font-body">
                  {t.title}
                </p>
                {t.description && (
                  <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-0.5 font-body">
                    {t.description}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => onDismiss(t.id)}
                className="text-[#64748B] dark:text-[#94A3B8] hover:text-[#0F172A] dark:hover:text-[#E2E8F0] transition-colors text-sm leading-none px-2 py-1 rounded-lg"
                aria-label="Dismiss notification"
              >
                ✕
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
