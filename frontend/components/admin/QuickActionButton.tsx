import Link from "next/link";

interface QuickActionButtonProps {
  href: string;
  label: string;
}

function getIcon(label: string) {
  const l = label.toLowerCase();
  if (l.includes("verification")) {
    // Review Verifications
    return (
      <svg className="w-5 h-5 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
      </svg>
    );
  }
  if (l.includes("queues")) {
    // View Queues
    return (
      <svg className="w-5 h-5 text-amber-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
      </svg>
    );
  }
  if (l.includes("flags") || l.includes("co2")) {
    // CO2 Flags
    return (
      <svg className="w-5 h-5 text-rose-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3 21v-4m0 0V5a2 2 0 012-2h6.5l1 1H21l-3 6 3 6h-8.5l-1-1H5a2 2 0 00-2 2zm9-13.5V9" />
      </svg>
    );
  }
  if (l.includes("analytics")) {
    // Analytics
    return (
      <svg className="w-5 h-5 text-emerald-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 002 2h2a2 2 0 002-2" />
      </svg>
    );
  }
  if (l.includes("webhook") || l.includes("dlq")) {
    // Webhook DLQ
    return (
      <svg className="w-5 h-5 text-blue-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 4H6a2 2 0 00-2 2v12a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-2m-4-1v8m0 0l3-3m-3 3L9 8m-5 5h2.586a1 1 0 01.707.293l2.414 2.414a1 1 0 00.707.293h3.172a1 1 0 00.707-.293l2.414-2.414a1 1 0 01.707-.293H20" />
      </svg>
    );
  }
  // Audit Log or fallback
  return (
    <svg className="w-5 h-5 text-purple-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );
}

export default function QuickActionButton({ href, label }: QuickActionButtonProps) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 p-4 rounded-xl border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] bg-white dark:bg-[#14142D] hover:bg-[rgba(99,102,241,0.02)] dark:hover:bg-[rgba(129,140,248,0.03)] hover:border-[rgba(99,102,241,0.25)] dark:hover:border-[rgba(129,140,248,0.30)] transition-all duration-200 group hover:shadow-sm"
      data-testid={`quick-action-${label.toLowerCase().replace(/\s+/g, "-")}`}
    >
      <div className="p-2 rounded-lg bg-[rgba(99,102,241,0.05)] dark:bg-[rgba(129,140,248,0.08)] group-hover:scale-105 transition-transform duration-200">
        {getIcon(label)}
      </div>
      <span className="text-sm font-semibold text-[var(--text)] font-body group-hover:text-[var(--primary)] transition-colors">
        {label}
      </span>
    </Link>
  );
}
