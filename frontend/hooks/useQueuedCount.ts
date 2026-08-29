import { useEffect, useState } from "react";
import {
  getQueuedCount,
  subscribeQueueChanged,
} from "@/lib/offlineDonationQueue";

/**
 * Live count of donations queued in IndexedDB while offline (issue #1096,
 * Workstream 2).  Shared by ConnectivityBanner and OfflineFallback so both
 * badges stay in sync — same state, same queue-changed subscription, same
 * 5-second polling fallback, same cleanup.
 *
 * @param isOnline - Whether the browser currently reports connectivity.
 * @returns The number of queued donations (0 while online).
 */
export default function useQueuedCount(isOnline: boolean): number {
  const [queuedCount, setQueuedCount] = useState(0);

  useEffect(() => {
    if (isOnline) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const count = await getQueuedCount();
        if (!cancelled) setQueuedCount(count);
      } catch {
        // IndexedDB unavailable — badge stays hidden.
      }
    };
    refresh();
    const unsubscribe = subscribeQueueChanged(() => {
      void refresh();
    });
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [isOnline]);

  return queuedCount;
}
