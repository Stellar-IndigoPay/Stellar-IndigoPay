interface OfflineFallbackProps {
  isOnline: boolean;
}

export default function OfflineFallback({ isOnline }: OfflineFallbackProps) {
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
    </div>
  );
}
