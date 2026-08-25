/**
 * components/DonationFeed.tsx
 * Recent donations for a project — live community feed with real-time SSE
 * streaming, virtualized rendering and cursor-based infinite scroll.
 *
 * Performance (GrantFox #1130 / #1025):
 *   - The list is rendered through `@tanstack/react-virtual`, so only the
 *     rows near the viewport exist in the DOM. A session with 5,000+
 *     donations stays responsive because the DOM node count is bounded by
 *     the viewport + overscan instead of the full history.
 *   - Older pages are loaded lazily via the existing cursor-based API as the
 *     user scrolls toward the bottom of the loaded history ("infinite
 *     scroll"), so the feed no longer materialises every donation at mount.
 *   - Real-time SSE donations are prepended at the top. If the user is
 *     scrolled into the history, the first visible row is re-anchored after
 *     the prepend so the viewport does not jump; if they are pinned at the
 *     top, the newest donation simply slides in above.
 *
 * A11y:
 *   - The scroll region is keyboard-scrollable (tabIndex) and exposes
 *     `role="list"` with per-row `role="listitem"`, `aria-setsize` and
 *     `aria-posinset` so screen readers announce a correct count even though
 *     only a window of rows is rendered.
 *   - A visually-hidden `aria-live="polite"` region announces each new
 *     donation, and `aria-busy` reflects background page loading.
 *   - A visible "Load more donations" button remains as a non-scroll
 *     fallback for keyboard/AT users.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { fetchProjectDonations } from "@/lib/api";
import { formatXLM, timeAgo, shortenAddress } from "@/utils/format";
import { explorerUrl, streamProjectPayments } from "@/lib/stellar";
import type { Donation } from "@/utils/types";
import { SkeletonList } from "./Skeleton";
import EmptyState from "./EmptyState";

// ── Tunables ──────────────────────────────────────────────────────────────────

/** Donations fetched per API page. */
const PAGE_SIZE = 10;
/** Estimated row height (px) used before a row has been measured. */
const ROW_ESTIMATE = 96;
/**
 * Distance from the bottom of the loaded history (px) that triggers loading
 * the next older page.
 */
const LOAD_MORE_THRESHOLD = 160;
/** Extra rows rendered above/below the viewport to mask measurement lag. */
const OVERSCAN = 8;
/** How long the "NEW" highlight stays on a just-arrived donation (ms). */
const NEW_HIGHLIGHT_MS = 2000;
/** Scroll offsets at/under which the user is treated as "pinned to top". */
const PINNED_TO_TOP_OFFSET = 4;
/** Max height of the internal scroll region (px). */
const FEED_MAX_HEIGHT = 560;

interface DonationFeedProps {
  projectId: string;
  walletAddress?: string;
  refreshKey?: number;
  onNewDonation?: (donation: Donation) => void;
}

export function DonationFeedSkeleton({ rows = 3 }: { rows?: number }) {
  return <SkeletonList rows={rows} withAvatar={true} palette="indigo" />;
}

export default function DonationFeed({
  projectId,
  walletAddress,
  refreshKey = 0,
  onNewDonation,
}: DonationFeedProps) {
  const [donations, setDonations] = useState<Donation[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const latestIdRef = useRef<string | null>(null);
  // Mirror of `donations` for use inside the (stable) SSE callback so the
  // stream is never torn down and restarted when new items arrive.
  const donationsRef = useRef<Donation[]>([]);
  donationsRef.current = donations;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  /**
   * When a real-time donation is prepended, we remember the row that was
   * first in the viewport and where it sat relative to the top, so the
   * layout effect can re-pin it and keep the user's position stable.
   */
  const anchorRef = useRef<{
    donationId: string;
    offsetFromTop: number;
    pinTop: boolean;
  } | null>(null);
  /** Set while a fresh initial page is landing, so we reset the scroll. */
  const pendingScrollResetRef = useRef(false);

  const rowVirtualizer = useVirtualizer({
    count: donations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_ESTIMATE,
    overscan: OVERSCAN,
    // Key rows by donation id so measurements survive index shifts when
    // real-time items are prepended.
    getItemKey: (index) => donations[index]?.id ?? `donation-${index}`,
  });

  // Load initial donation data from the backend API
  useEffect(() => {
    setLoading(true);
    pendingScrollResetRef.current = true;
    fetchProjectDonations(projectId, PAGE_SIZE)
      .then(({ donations: data, nextCursor: cursor }) => {
        setDonations(data);
        setNextCursor(cursor);
        latestIdRef.current = data[0]?.id ?? null;
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId, refreshKey]);

  // When a fresh initial page lands (project change / manual refresh), jump
  // back to the newest donation at the top of the feed.
  useLayoutEffect(() => {
    if (!pendingScrollResetRef.current) return;
    pendingScrollResetRef.current = false;
    rowVirtualizer.scrollToOffset(0);
  }, [donations, rowVirtualizer]);

  // Load the next (older) page of donations.
  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const { donations: newDonations, nextCursor: cursor } =
        await fetchProjectDonations(projectId, PAGE_SIZE, nextCursor);
      setDonations((prev) => {
        // Drop any items that arrived via SSE while the page was in flight.
        const seen = new Set(prev.map((d) => d.id));
        const fresh = newDonations.filter((d) => !seen.has(d.id));
        return fresh.length > 0 ? [...prev, ...fresh] : prev;
      });
      setNextCursor(cursor);
    } catch (error) {
      console.error(error);
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, nextCursor, loadingMore]);

  // Distance (px) from the bottom of the loaded history to the viewport
  // bottom. Recomputed every render and kept as a variable so the infinite-
  // scroll effect can list it as a dependency.
  const distanceFromEnd =
    rowVirtualizer.getTotalSize() -
    (rowVirtualizer.scrollRect?.height ?? 0) -
    (rowVirtualizer.scrollOffset ?? 0);

  // Infinite scroll: while the user is near the bottom of the loaded
  // history, fetch the next older page. Also auto-fills short feeds until
  // the container is full or the cursor runs out.
  useEffect(() => {
    if (loading || loadingMore || !nextCursor || !scrollRef.current) return;
    if (distanceFromEnd <= LOAD_MORE_THRESHOLD) {
      void loadMore();
    }
  }, [loading, loadingMore, nextCursor, distanceFromEnd, donations.length, loadMore]);

  // Handle incoming SSE payment
  const handleNewPayment = useCallback(
    (payment: {
      id: string;
      from: string;
      amount: string;
      asset: string;
      createdAt: string;
      transactionHash: string;
    }) => {
      const newDonation: Donation = {
        id: payment.id,
        projectId,
        donorAddress: payment.from,
        amountXLM: payment.amount,
        amount: payment.amount,
        currency: (payment.asset === "XLM" ? "XLM" : "USDC") as "XLM" | "USDC",
        transactionHash: payment.transactionHash,
        createdAt: payment.createdAt,
      };

      // Capture the viewport anchor BEFORE the state update so we can re-pin
      // it after the new donation is prepended. Anchor on the first row that
      // actually intersects the viewport (overscan rows above it are ignored).
      const scrollOffset = rowVirtualizer.scrollOffset ?? 0;
      const firstVisible = rowVirtualizer
        .getVirtualItems()
        .find((item) => item.end > scrollOffset);
      if (firstVisible) {
        const anchorId = donationsRef.current[firstVisible.index]?.id;
        if (anchorId) {
          if (firstVisible.index === 0 && scrollOffset <= PINNED_TO_TOP_OFFSET) {
            // Pinned at the top: stay pinned so the newest donation slides
            // into view above instead of being pushed off-screen.
            anchorRef.current = {
              donationId: anchorId,
              offsetFromTop: 0,
              pinTop: true,
            };
          } else {
            anchorRef.current = {
              donationId: anchorId,
              // May be negative when the anchor's top edge is already scrolled
              // slightly above the viewport — preserve that exact position.
              offsetFromTop: firstVisible.start - scrollOffset,
              pinTop: false,
            };
          }
        }
      }

      setDonations((prev) => {
        if (prev.some((d) => d.id === newDonation.id)) return prev;
        return [newDonation, ...prev];
      });

      setNewIds((prev) => new Set(prev).add(payment.id));
      setTimeout(() => {
        setNewIds((prev) => {
          const next = new Set(prev);
          next.delete(payment.id);
          return next;
        });
      }, NEW_HIGHLIGHT_MS);

      onNewDonation?.(newDonation);

      latestIdRef.current = payment.id;
    },
    [projectId, onNewDonation, rowVirtualizer],
  );

  // Start SSE stream once initial data is loaded
  useEffect(() => {
    if (loading || !walletAddress) return;

    const cursor = latestIdRef.current || undefined;
    const closeStream = streamProjectPayments(
      walletAddress,
      handleNewPayment,
      cursor,
    );

    return () => {
      closeStream();
    };
  }, [loading, walletAddress, handleNewPayment]);

  // Re-pin the viewport after real-time donations are prepended at the top.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    anchorRef.current = null;

    const newIndex = donations.findIndex((d) => d.id === anchor.donationId);
    if (newIndex === -1) return;

    if (anchor.pinTop) {
      rowVirtualizer.scrollToOffset(0);
      return;
    }

    const positioned = rowVirtualizer.getOffsetForIndex(newIndex, "start");
    if (!positioned) return;
    const [itemStartOffset] = positioned;
    rowVirtualizer.scrollToOffset(
      Math.max(0, itemStartOffset - anchor.offsetFromTop),
    );
  }, [donations, rowVirtualizer]);

  if (loading) return <DonationFeedSkeleton />;

  if (donations.length === 0)
    return (
      <div>
        {walletAddress && (
          <div className="flex items-center gap-2 mb-3 text-xs text-[#4F46E5] dark:text-[#818CF8] font-body">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Listening for live donations…
          </div>
        )}
        <EmptyState
          variant="empty"
          title="No donations yet"
          description="Be the first to support this project!"
          className="py-6"
          headingLevel="h3"
        />
      </div>
    );

  const virtualItems = rowVirtualizer.getVirtualItems();

  return (
    <div className="space-y-2">
      {walletAddress && (
        <div className="flex items-center gap-2 mb-1 text-xs text-[#4F46E5] dark:text-[#818CF8] font-body">
          <span
            className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
            aria-hidden="true"
          />
          Live — new donations appear automatically
        </div>
      )}
      {/* Hidden aggregate live region so each new donation is announced. The
          key changes when a new donation lands so the message is re-read even
          when only a single live region is present. */}
      <p
        key={donations[0]?.id ?? "empty"}
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
      >
        {donations.length > 0
          ? `${donations.length} donation${
              donations.length === 1 ? "" : "s"
            } shown; most recent ${
              donations[0]?.currency === "USDC"
                ? `${parseFloat(donations[0].amount || "0").toFixed(2)} USDC`
                : formatXLM(donations[0]?.amountXLM || donations[0]?.amount || "0")
            } from ${shortenAddress(donations[0]?.donorAddress || "")}.`
          : ""}
      </p>

      {/* Virtualized scroll region — only the visible window of rows is in
          the DOM, so the node count stays bounded no matter how many
          donations accumulate. */}
      <div
        ref={scrollRef}
        role="list"
        aria-label="Recent donations"
        aria-busy={loadingMore}
        tabIndex={0}
        className="max-h-[560px] overflow-y-auto overscroll-contain rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-1"
        style={{ maxHeight: FEED_MAX_HEIGHT }}
        data-testid="donation-feed-scroll"
      >
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            position: "relative",
            width: "100%",
          }}
        >
          {virtualItems.map((virtualRow) => {
            const d = donations[virtualRow.index];
            if (!d) return null;
            return (
              <div
                key={virtualRow.key}
                ref={rowVirtualizer.measureElement}
                data-index={virtualRow.index}
                role="listitem"
                aria-setsize={donations.length}
                aria-posinset={virtualRow.index + 1}
                className={`flex items-start gap-3 p-3 rounded-xl bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-all duration-500 ${
                  newIds.has(d.id)
                    ? "animate-slide-in ring-2 ring-emerald-400/50 bg-emerald-50"
                    : ""
                }`}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div
                  className="w-9 h-9 rounded-full bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] flex items-center justify-center flex-shrink-0 text-base"
                  aria-hidden="true"
                >
                  {newIds.has(d.id) ? "✨" : "🌱"}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] text-sm font-body">
                      {d.anonymous || !d.donorAddress
                        ? "Anonymous"
                        : shortenAddress(d.donorAddress, 5)}
                    </span>
                    <span className="font-mono font-bold text-[#4F46E5] dark:text-[#818CF8] text-sm">
                      {d.currency === "USDC"
                        ? `$${parseFloat(d.amount || "0").toFixed(2)} USDC`
                        : formatXLM(d.amountXLM || d.amount || "0")}
                    </span>
                    {d.isMatched && (
                      <span className="text-xs bg-purple-100 text-purple-700 px-1.5 py-0.5 rounded-full font-body font-semibold">
                        Matched!
                      </span>
                    )}
                    {newIds.has(d.id) && (
                      <span className="text-xs bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded-full font-body font-semibold">
                        NEW
                      </span>
                    )}
                  </div>
                  {d.message && (
                    <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-0.5 italic font-body">
                      &quot;{d.message}&quot;
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
                      {timeAgo(d.createdAt)}
                    </span>
                    <a
                      href={explorerUrl(d.transactionHash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-[#4F46E5] dark:text-[#818CF8] hover:text-[#6366F1] transition-colors font-body"
                    >
                      View tx ↗
                    </a>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {nextCursor && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full mt-4 px-4 py-2 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] hover:bg-[rgba(99,102,241,0.15)] dark:hover:bg-[rgba(129,140,248,0.18)] text-[#4F46E5] dark:text-[#818CF8] rounded-lg transition-colors font-body text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loadingMore ? "Loading..." : "Load more donations"}
        </button>
      )}

      <style jsx>{`
        @keyframes slide-in {
          from {
            opacity: 0;
            transform: translateY(-12px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        :global(.animate-slide-in) {
          animation: slide-in 0.4s ease-out;
        }
      `}</style>
    </div>
  );
}
