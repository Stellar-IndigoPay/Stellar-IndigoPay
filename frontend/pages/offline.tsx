import Head from "next/head";
import Link from "next/link";
import useQueuedCount from "@/hooks/useQueuedCount";
import useOnlineStatus from "@/hooks/useOnlineStatus";

/**
 * pages/offline.tsx
 *
 * Offline page served from the Service Worker app-shell cache (public/sw.js
 * caches "/offline" on install).  Shows the queued-donation badge so a donor
 * who lands here without connectivity knows their queued gifts are safe and
 * will be submitted on reconnect.
 */
export default function Offline() {
  const isOnline = useOnlineStatus();
  const queuedCount = useQueuedCount(isOnline);

  return (
    <>
      <Head>
        <title>You&apos;re offline | IndigoPay</title>
      </Head>

      <div className="min-h-screen bg-leaf flex flex-col items-center justify-center px-4 py-16">
        <div className="text-8xl mb-6 select-none">📶</div>

        <h1 className="font-display text-4xl sm:text-5xl font-semibold text-gradient-green text-center mb-4">
          You&apos;re offline
        </h1>

        <p className="font-body text-lg sm:text-xl text-[#1a2e1a] font-medium text-center mb-2">
          The app is available in a limited offline mode.
        </p>
        <p className="font-body text-sm text-[#5a7a5a] dark:text-[#8aaa8a] text-center mb-6 max-w-sm">
          Cached content remains accessible, and donations you start will be
          queued until you reconnect.
        </p>

        {queuedCount > 0 && (
          <p
            className="mb-8 inline-flex items-center gap-2 rounded-full border border-[rgba(99,102,241,0.20)] dark:border-[rgba(129,140,248,0.25)] bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] px-4 py-1.5 text-sm font-semibold text-[#4F46E5] dark:text-[#818CF8]"
            data-testid="offline-queued-badge"
          >
            {queuedCount} donation{queuedCount === 1 ? "" : "s"} queued — will
            submit when you&apos;re back online.
          </p>
        )}

        <div className="flex flex-col sm:flex-row gap-3 w-full max-w-xs sm:max-w-none sm:w-auto">
          <Link href="/projects" className="btn-primary text-center">
            Browse Projects
          </Link>
          <Link href="/" className="btn-secondary text-center">
            Go Home
          </Link>
        </div>

        <p className="mt-16 text-xs text-[#5a7a5a] dark:text-[#8aaa8a] font-body">
          🌱 IndigoPay — every donation tracked on-chain
        </p>
      </div>
    </>
  );
}
