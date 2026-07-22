/**
 * components/LeaderboardTable.tsx
 */
import { formatXLM, formatUSDEquivalent, shortenAddress, badgeEmoji } from "@/utils/format";
import { accountUrl } from "@/lib/stellar";
import { useXlmPrice } from "@/lib/priceContext";
import type { LeaderboardEntry } from "@/utils/types";
import { SkeletonList } from "./Skeleton";
import { useLeaderboard } from "@/hooks/queries";
import { QueryErrorFallback } from "@/components/QueryErrorFallback";
import { useI18n } from "@/lib/i18n";

const AVATAR_COLORS = [
  "#4F46E5",
  "#7C3AED",
  "#2563EB",
  "#0891B2",
  "#059669",
  "#D97706",
  "#DC2626",
  "#9333EA",
];

function hashToIndex(input: string, modulo: number) {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash % modulo;
}

function avatarInitials(displayName: string | undefined, publicKey: string) {
  const source = (displayName || publicKey).trim();
  const first = source[0] || "G";
  const second = source[1] || "P";
  return `${first}${second}`.toUpperCase();
}

function Avatar({
  publicKey,
  displayName,
}: {
  publicKey: string;
  displayName?: string;
}) {
  const bg = AVATAR_COLORS[hashToIndex(publicKey, AVATAR_COLORS.length)];
  return (
    <div
      className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 font-display text-sm"
      style={{ backgroundColor: bg, color: "white" }}
      aria-hidden="true"
      title={displayName || publicKey}
    >
      {avatarInitials(displayName, publicKey)}
    </div>
  );
}

export function LeaderboardTableSkeleton({ rows = 5 }: { rows?: number }) {
  return <SkeletonList rows={rows} withAvatar={true} palette="indigo" />;
}

export default function LeaderboardTable({
  limit = 20,
  period = "all",
}: {
  limit?: number;
  period?: "all" | "month" | "year";
}) {
  const xlmUsd = useXlmPrice();

  const {
    data: entries,
    isLoading,
    isError,
    error,
    refetch,
    isRefetching,
  } = useLeaderboard(limit, period);

  const { t } = useI18n();

  if (isLoading) return <LeaderboardTableSkeleton />;

  if (isError || isRefetching)
    return (
      <QueryErrorFallback
        error={error}
        onRetry={() => refetch()}
        isRetrying={isRefetching}
        retryCount={0}
        title={t("leaderboard.failedToLoad")}
      />
    );

  const safeEntries = entries ?? [];

  if (safeEntries.length === 0)
    return (
      <div className="text-center py-12">
        <p className="text-3xl mb-3">🌱</p>
        <p className="text-[#475569] dark:text-[#94A3B8] font-body">
          {t("leaderboard.noDonors")}
        </p>
      </div>
    );

  const medals = ["🥇", "🥈", "🥉"];

  return (
    <div className="space-y-2">
      {safeEntries.map((entry) => (
        <div
          key={entry.publicKey}
          className="flex items-center gap-4 p-4 rounded-xl bg-white dark:bg-[#14142D] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] hover:border-[rgba(99,102,241,0.25)] dark:hover:border-[rgba(129,140,248,0.30)] transition-all"
        >
          {/* Rank */}
          <div className="w-8 text-center flex-shrink-0">
            {entry.rank <= 3 ? (
              <span className="text-lg">{medals[entry.rank - 1]}</span>
            ) : (
              <span className="text-sm font-semibold text-[#64748B] dark:text-[#94A3B8] font-body">
                #{entry.rank}
              </span>
            )}
          </div>

          {/* Badge */}
          {entry.topBadge && (
            <span className="text-xl flex-shrink-0" title={entry.topBadge}>
              {badgeEmoji(entry.topBadge)}
            </span>
          )}

          {/* Name / address */}
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <Avatar
              publicKey={entry.publicKey}
              displayName={entry.displayName}
            />
            <div className="min-w-0">
              <a
                href={accountUrl(entry.publicKey)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-[#0F172A] dark:text-[#E2E8F0] hover:text-[#4F46E5] dark:hover:text-[#818CF8] transition-colors text-sm font-body block truncate"
              >
                {entry.displayName || shortenAddress(entry.publicKey)}
              </a>
              <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body mt-0.5">
                {entry.projectsSupported} project
                {entry.projectsSupported !== 1 ? "s" : ""} supported
              </p>
            </div>
          </div>

          {/* Total donated */}
          <div className="text-right flex-shrink-0">
            <p className="font-mono font-semibold text-[#4F46E5] dark:text-[#818CF8] text-sm">
              {formatXLM(entry.totalDonatedXLM)}
            </p>
            {formatUSDEquivalent(entry.totalDonatedXLM, xlmUsd) && (
              <p className="text-[11px] text-[#64748B] dark:text-[#94A3B8] font-body">
                {formatUSDEquivalent(entry.totalDonatedXLM, xlmUsd)}
              </p>
            )}
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
              donated
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
