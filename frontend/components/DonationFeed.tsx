/**
 * components/DonationFeed.tsx
 * Recent donations for a project â€” live community feed with real-time SSE streaming.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { formatXLM, timeAgo, shortenAddress } from "@/utils/format";
import { explorerUrl, streamProjectPayments } from "@/lib/stellar";
import type { Donation } from "@/utils/types";
import { SkeletonList } from "./Skeleton";
import EmptyState from "./EmptyState";
import {
  queryKeys,
  useProjectDonations,
  type ProjectDonationsPage,
} from "@/hooks/queries";
import { QueryErrorFallback } from "@/components/QueryErrorFallback";

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
  const queryClient = useQueryClient();
  const {
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    isFetchingNextPage,
    fetchNextPage,
    hasNextPage,
  } = useProjectDonations(projectId, 10);
  const donations = useMemo(
    () => data?.pages.flatMap((page) => page.donations) ?? [],
    [data],
  );
  const nextCursor = data?.pages.at(-1)?.nextCursor ?? null;
  const [newIds, setNewIds] = useState<Set<string>>(new Set());
  const latestIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (donations.length > 0) latestIdRef.current = donations[0].id;
  }, [donations]);

  // Keep this prop for existing callers while the cache is now the source of truth.
  useEffect(() => {
    if (refreshKey > 0) void refetch();
  }, [refreshKey, refetch]);

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

      let wasInserted = false;
      queryClient.setQueryData(
        queryKeys.projectDonations(projectId, 10),
        (previous: { pages: ProjectDonationsPage[]; pageParams: unknown[] } | undefined) => {
          if (!previous) return previous;
          if (previous.pages.some((page) =>
            page.donations.some(
              (donation) =>
                donation.id === newDonation.id ||
                donation.transactionHash === newDonation.transactionHash,
            ),
          )) return previous;
          wasInserted = true;
          return {
            ...previous,
            pages: previous.pages.map((page, index) =>
              index === 0
                ? { ...page, donations: [newDonation, ...page.donations] }
                : page,
            ),
          };
        },
      );
      if (!wasInserted) return;

      setNewIds((prev) => new Set(prev).add(payment.id));
      setTimeout(() => {
        setNewIds((prev) => {
          const next = new Set(prev);
          next.delete(payment.id);
          return next;
        });
      }, 2000);

      onNewDonation?.(newDonation);

      latestIdRef.current = payment.id;
    },
    [projectId, onNewDonation, queryClient],
  );

  // Start SSE stream once initial data is loaded
  useEffect(() => {
    if (isLoading || isError || !walletAddress) return;

    const cursor = latestIdRef.current || undefined;
    const closeStream = streamProjectPayments(
      walletAddress,
      handleNewPayment,
      cursor,
    );

    return () => {
      closeStream();
    };
  }, [isLoading, isError, walletAddress, handleNewPayment]);

  const handleLoadMore = async () => {
    if (!nextCursor || isFetchingNextPage || !hasNextPage) return;
    await fetchNextPage();
  };

  if (isLoading)
    return <DonationFeedSkeleton />;

  if (isError && donations.length === 0)
    return (
      <QueryErrorFallback
        error={error}
        onRetry={() => void refetch()}
        isRetrying={isFetching}
        title="Couldn&apos;t load recent donations"
      />
    );

  if (donations.length === 0)
    return (
      <div>
        {walletAddress && (
          <div className="flex items-center gap-2 mb-3 text-xs text-[#4F46E5] dark:text-[#818CF8] font-body">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Listening for live donationsâ€¦
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

  return (
    <div className="space-y-2">
      {walletAddress && (
        <div className="flex items-center gap-2 mb-1 text-xs text-[#4F46E5] dark:text-[#818CF8] font-body">
          <span
            className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
            aria-hidden="true"
          />
          Live â€” new donations appear automatically
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
      {donations.map((d) => (
        <div
          key={d.id}
          className={`flex items-start gap-3 p-3 rounded-xl bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] hover:bg-[rgba(99,102,241,0.08)] dark:hover:bg-[rgba(129,140,248,0.10)] transition-all duration-500 ${
            newIds.has(d.id)
              ? "animate-slide-in ring-2 ring-emerald-400/50 bg-emerald-50"
              : ""
          }`}
        >
          <div
            className="w-9 h-9 rounded-full bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)] flex items-center justify-center flex-shrink-0 text-base"
            aria-hidden="true"
          >
            {newIds.has(d.id) ? "âœ¨" : "ðŸŒ±"}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] text-sm font-body">
                {d.anonymous || !d.donorAddress
                  ? "Anonymous"
                  : shortenAddress(d.donorAddress, 5)}
                {d.donorAddress ? shortenAddress(d.donorAddress, 5) : "Anonymous"}
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
                View tx â†—
              </a>
            </div>
          </div>
        </div>
      ))}
      {nextCursor && hasNextPage && (
        <button
          onClick={handleLoadMore}
          disabled={isFetchingNextPage}
          className="w-full mt-4 px-4 py-2 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] hover:bg-[rgba(99,102,241,0.15)] dark:hover:bg-[rgba(129,140,248,0.18)] text-[#4F46E5] dark:text-[#818CF8] rounded-lg transition-colors font-body text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isFetchingNextPage ? "Loading..." : "Load more donations"}
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
