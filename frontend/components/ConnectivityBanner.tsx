interface ConnectivityBannerProps {
  isOnline: boolean;
}

export default function ConnectivityBanner({
  isOnline,
}: ConnectivityBannerProps) {
  if (isOnline) return null;

  return (
    <div
      className="sticky top-0 z-50 border-b border-amber-200 bg-amber-50 px-4 py-3 text-center text-sm font-medium text-amber-800 dark:border-amber-800/40 dark:bg-amber-950/40 dark:text-amber-200"
      role="status"
      aria-live="polite"
    >
      You&apos;re offline. Donations will be queued and sent automatically when
      connectivity returns.
    </div>
  );
}
