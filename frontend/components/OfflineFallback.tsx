import useQueuedCount from "@/hooks/useQueuedCount";

interface OfflineFallbackProps {
  isOnline: boolean;
}

export default function OfflineFallback({ isOnline }: OfflineFallbackProps) {
  const queuedCount = useQueuedCount(isOnline);

  if (isOnline) return null;

  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center justify-center rounded-3xl border border-[rgba(99,102,241,0.12)] bg-[rgba(99,102,241,0.04)] px-6 py-10 text-center shadow-sm">
      <div className="mb-4 text-5xl">📶</div>
      <h2 className="font-display text-2xl font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
        You&apos;re offline
      </h2>
      <p className="mt-3 max-w-lg text-sm leading-6 text-[#475569] dark:text-[#94A3B8]">
        The app is available in a limited offline mode. Cached content remains
        accessible, and donations you start will be queued until you reconnect.
      </p>
      {queuedCount > 0 && (
        <p
          className="mt-4 inline-flex items-center gap-2 rounded-full border border-[rgba(99,102,241,0.20)] dark:border-[rgba(129,140,248,0.25)] bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] px-4 py-1.5 text-sm font-semibold text-[#4F46E5] dark:text-[#818CF8]"
          data-testid="offline-queued-badge"
        >
          {queuedCount} donation{queuedCount === 1 ? "" : "s"} queued — will
          submit when you&apos;re back online.
        </p>
      )}
    </div>
  );
}
