import { useState, useEffect, memo } from "react";
import Link from "next/link";
import { formatXLM } from "@/utils/format";

export interface Donation {
  id: string;
  projectId: string;
  projectName: string;
  amountXLM: string;
  createdAt: string;
}

interface Props {
  donations: Donation[];
}

const LiveDonationTicker = memo(function LiveDonationTicker({ donations }: Props) {
  const [tickerIndex, setTickerIndex] = useState(0);

  useEffect(() => {
    if (donations.length <= 1) return;

    const timer = setInterval(() => {
      setTickerIndex((current) => (current + 1) % donations.length);
    }, 3500);

    return () => clearInterval(timer);
  }, [donations.length]);

  // Safety: reset index if it exceeds the array
  useEffect(() => {
    if (tickerIndex >= donations.length) {
      setTickerIndex(0);
    }
  }, [donations.length, tickerIndex]);

  if (donations.length === 0) return null;

  const item = donations[tickerIndex];
  if (!item) return null;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-40 border-t border-[rgba(99,102,241,0.20)] dark:border-[rgba(129,140,248,0.20)] bg-[#0F172A]/95 dark:bg-[#0A0A1A]/95 backdrop-blur px-4 py-2.5"
      role="region"
      aria-label="Live donation ticker"
    >
      <div className="max-w-6xl mx-auto flex items-center gap-3 text-sm text-white font-body">
        <span className="inline-flex items-center gap-2 text-[11px] uppercase tracking-widest text-[#818CF8] font-bold">
          <span
            className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse shadow-sm shadow-emerald-500/50"
            aria-hidden="true"
          />
          Live donations
        </span>
        <p key={item.id} className="animate-fade-in-up" aria-live="polite">
          <span className="sr-only">A new donation: </span>
          just donated <strong>{formatXLM(item.amountXLM)}</strong> to{" "}
          <Link
            href={`/projects/${item.projectId}`}
            className="text-[#A5B4FC] hover:text-[#818CF8] transition-colors focus:outline-none focus:ring-2 focus:ring-[#818CF8] rounded"
          >
            {item.projectName}
          </Link>
        </p>
      </div>
    </div>
  );
});

export default LiveDonationTicker;
