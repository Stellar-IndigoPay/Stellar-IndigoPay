import clsx from "clsx";

interface StatusDotProps {
  status?: "green" | "red" | "amber" | "blue";
  size?: "sm" | "md" | "lg";
  className?: string;
}

const colorClasses = {
  green: "bg-emerald-500 shadow-emerald-500/50",
  red: "bg-rose-500 shadow-rose-500/50",
  amber: "bg-amber-500 shadow-amber-500/50",
  blue: "bg-indigo-500 shadow-indigo-500/50",
};

const pingColorClasses = {
  green: "bg-emerald-400",
  red: "bg-rose-400",
  amber: "bg-amber-400",
  blue: "bg-indigo-400",
};

const sizeClasses = {
  sm: "w-2.5 h-2.5",
  md: "w-3.5 h-3.5",
  lg: "w-4.5 h-4.5",
};

export default function StatusDot({
  status = "green",
  size = "md",
  className = "",
}: StatusDotProps) {
  return (
    <span className={clsx("relative flex", sizeClasses[size], className)} data-testid="status-dot">
      {status === "green" && (
        <span
          className={clsx(
            "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
            pingColorClasses[status],
          )}
        />
      )}
      <span
        className={clsx(
          "relative inline-flex rounded-full shadow-md",
          sizeClasses[size],
          colorClasses[status],
        )}
      />
    </span>
  );
}
