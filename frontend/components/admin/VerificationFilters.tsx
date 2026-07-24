interface VerificationFiltersProps {
  value: string;
  onChange: (value: string) => void;
}

const STATUSES = [
  { key: "all", label: "All" },
  { key: "pending", label: "Pending" },
  { key: "in_review", label: "In Review" },
  { key: "approved", label: "Approved" },
  { key: "rejected", label: "Rejected" },
];

export default function VerificationFilters({
  value,
  onChange,
}: VerificationFiltersProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {STATUSES.map((status) => {
        const isActive = value === status.key;
        return (
          <button
            key={status.key}
            type="button"
            onClick={() => onChange(status.key)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors ${
              isActive
                ? "bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300"
                : "bg-gray-100 text-gray-600 dark:bg-white/5 dark:text-gray-300"
            }`}
            aria-pressed={isActive}
          >
            {status.label}
          </button>
        );
      })}
    </div>
  );
}
