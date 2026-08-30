import useQueuedCount from "@/hooks/useQueuedCount";

interface ConnectivityBannerProps {
  isOnline: boolean;
}

export default function ConnectivityBanner({
  isOnline,
}: ConnectivityBannerProps) {
  // Workstream 2: while offline, surface how many donations are queued so the
  // donor knows they are safe and will be submitted on reconnect.
  const queuedCount = useQueuedCount(isOnline);

  if (isOnline) return null;

  return (
    <div
      className="sticky top-0 z-50 border-b border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-200"
      role="status"
      aria-live="polite"
    >
      You&apos;re offline. Donations will be queued and sent automatically when
      connectivity returns.
      {queuedCount > 0 && (
        <span
          className="mt-1 block text-xs font-semibold"
          data-testid="queued-count-badge"
        >
          {queuedCount} donation{queuedCount === 1 ? "" : "s"} queued — will
          submit when you&apos;re back online.
        </span>
      )}
    </div>
  );
}
