import clsx from "clsx";
import { SkeletonBox } from "@/components/Skeleton";

interface StatCardProps {
  title: string;
  value: string | number | undefined;
  color: "blue" | "amber" | "red" | "green";
  loading?: boolean;
}

const colorMaps = {
  blue: {
    text: "text-blue-600 dark:text-blue-400",
    bg: "bg-blue-50/50 dark:bg-blue-900/10",
    border: "border-blue-100 dark:border-blue-900/20 hover:border-blue-200 dark:hover:border-blue-800/40",
    iconBg: "bg-blue-100/80 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400",
  },
  amber: {
    text: "text-amber-600 dark:text-amber-400",
    bg: "bg-amber-50/50 dark:bg-amber-900/10",
    border: "border-amber-100 dark:border-amber-900/20 hover:border-amber-200 dark:hover:border-amber-800/40",
    iconBg: "bg-amber-100/80 dark:bg-amber-900/30 text-amber-600 dark:text-amber-400",
  },
  red: {
    text: "text-rose-600 dark:text-rose-400",
    bg: "bg-rose-50/50 dark:bg-rose-900/10",
    border: "border-rose-100 dark:border-rose-900/20 hover:border-rose-200 dark:hover:border-rose-800/40",
    iconBg: "bg-rose-100/80 dark:bg-rose-900/30 text-rose-600 dark:text-rose-400",
  },
  green: {
    text: "text-emerald-600 dark:text-emerald-400",
    bg: "bg-emerald-50/50 dark:bg-emerald-900/10",
    border: "border-emerald-100 dark:border-emerald-900/20 hover:border-emerald-200 dark:hover:border-emerald-800/40",
    iconBg: "bg-emerald-100/80 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400",
  },
};

function getIcon(title: string) {
  const t = title.toLowerCase();
  if (t.includes("active")) {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (t.includes("waiting")) {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (t.includes("failed")) {
    return (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
      </svg>
    );
  }
  return (
    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

export default function StatCard({ title, value, color, loading = false }: StatCardProps) {
  const styles = colorMaps[color];

  return (
    <div
      className={clsx(
        "card rounded-2xl p-5 border transition-all duration-300 hover:shadow-lg dark:hover:shadow-none hover:-translate-y-0.5",
        styles.border,
        styles.bg
      )}
      data-testid={`stat-card-${color}`}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-semibold text-[var(--text-secondary)] font-body uppercase tracking-wider">
          {title}
        </span>
        <div className={clsx("p-2 rounded-xl", styles.iconBg)}>
          {getIcon(title)}
        </div>
      </div>
      {loading ? (
        <SkeletonBox className="h-9 rounded w-20" palette="indigo" />
      ) : (
        <p className={clsx("text-3xl font-display font-bold leading-tight", styles.text)}>
          {value ?? "0"}
        </p>
      )}
    </div>
  );
}
