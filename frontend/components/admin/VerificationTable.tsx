/**
 * components/admin/VerificationTable.tsx — Reusable verification requests table
 *
 * Renders a sortable, filterable admin verification queue using TanStack table.
 */
import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";
import { formatDate, CATEGORY_ICONS } from "@/utils/format";
import type { VerificationRequestResponse } from "@/lib/api";

export type VerificationStatus =
  | "pending"
  | "in_review"
  | "approved"
  | "rejected";

export const STATUS_LABELS: Record<VerificationStatus, string> = {
  pending: "Pending",
  in_review: "In Review",
  approved: "Approved",
  rejected: "Rejected",
};

export const STATUS_COLORS: Record<VerificationStatus, string> = {
  pending:
    "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-900/30 dark:text-amber-300 dark:border-amber-700/40",
  in_review:
    "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-900/30 dark:text-blue-300 dark:border-blue-700/40",
  approved:
    "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-300 dark:border-emerald-700/40",
  rejected:
    "bg-red-50 text-red-700 border-red-200 dark:bg-red-900/30 dark:text-red-300 dark:border-red-700/40",
};

interface VerificationTableProps {
  requests: VerificationRequestResponse[];
  loading?: boolean;
  error?: string | null;
  onStartReview?: (id: string) => void;
  hideActions?: boolean;
  page?: number;
  pageSize?: number;
  totalCount?: number;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}

function StatusBadge({ status }: { status: VerificationStatus }) {
  const label = STATUS_LABELS[status] || status;
  return (
    <span
      className={`inline-flex text-xs font-semibold px-2.5 py-1 rounded-full border ${
        STATUS_COLORS[status] || STATUS_COLORS.pending
      }`}
    >
      {label}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="card p-0 overflow-hidden">
      <div className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="flex items-center gap-4 px-6 py-4 animate-pulse">
            <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/4" />
            <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/5" />
            <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
            <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
            <div className="h-4 bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)] rounded w-1/6" />
          </div>
        ))}
      </div>
    </div>
  );
}

export default function VerificationTable({
  requests,
  loading = false,
  error = null,
  onStartReview,
  hideActions = false,
  page = 1,
  pageSize = 10,
  totalCount = requests.length,
  onPageChange,
  onPageSizeChange,
}: VerificationTableProps) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [expandedRows, setExpandedRows] = useState<Record<string, boolean>>({});

  const columns = useMemo<ColumnDef<VerificationRequestResponse>[]>(
    () => {
      const baseColumns: ColumnDef<VerificationRequestResponse>[] = [
      {
        accessorKey: "organizationName",
        id: "organizationName",
        header: "Organization",
        enableSorting: true,
        cell: ({ row }) => (
          <div>
            <Link
              href={`/admin/verification/${row.original.id}`}
              className="block"
            >
              <p className="text-sm font-semibold text-[var(--text)] font-body hover:text-[var(--primary)] transition-colors">
                {row.original.organizationName}
              </p>
              {row.original.organizationCountry && (
                <p className="text-xs text-[var(--muted)] font-body mt-0.5">
                  {row.original.organizationCountry}
                </p>
              )}
            </Link>
          </div>
        ),
      },
      {
        accessorKey: "projectName",
        id: "projectName",
        header: "Project",
        enableSorting: true,
        cell: ({ row }) => {
          const icon = CATEGORY_ICONS[row.original.projectCategory] || "🌿";
          return (
            <Link href={`/admin/verification/${row.original.id}`} className="block">
              <p className="text-sm font-medium text-[var(--text)] font-body">
                {icon} {row.original.projectName}
              </p>
            </Link>
          );
        },
      },
      {
        accessorKey: "projectCategory",
        id: "projectCategory",
        header: "Category",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="text-sm text-[var(--text-secondary)] font-body">
            {row.original.projectCategory}
          </span>
        ),
      },
      {
        accessorKey: "co2PerXLM",
        id: "co2PerXLM",
        header: "CO₂ / XLM",
        enableSorting: true,
        sortingFn: (rowA, rowB) => {
          const a = Number(rowA.getValue("co2PerXLM") || 0);
          const b = Number(rowB.getValue("co2PerXLM") || 0);
          return a - b;
        },
        cell: ({ row }) => (
          <span className="text-sm text-[var(--text-secondary)] font-body">
            {Math.round(Number(row.original.co2PerXLM || 0) * 100) / 100} g
          </span>
        ),
      },
      {
        accessorKey: "status",
        id: "status",
        header: "Status",
        enableSorting: true,
        filterFn: "equals",
        cell: ({ row }) => <StatusBadge status={row.original.status} />,
      },
      {
        accessorKey: "submittedAt",
        id: "submittedAt",
        header: "Submitted",
        enableSorting: true,
        cell: ({ row }) => (
          <span className="text-sm text-[var(--text-secondary)] font-body">
            {row.original.submittedAt ? formatDate(row.original.submittedAt) : "—"}
          </span>
        ),
      },
      {
        id: "actions",
        header: "Actions",
        enableSorting: false,
        cell: ({ row }) => (
          <div className="flex items-center justify-end gap-2">
            {onStartReview && row.original.status === "pending" && (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  onStartReview(row.original.id);
                }}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] text-white hover:opacity-90 transition-all"
              >
                Start Review
              </button>
            )}
            <Link
              href={`/admin/verification/${row.original.id}`}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[var(--primary)] hover:bg-[rgba(99,102,241,0.06)] dark:hover:bg-[rgba(129,140,248,0.08)] transition-all"
            >
              View Details
            </Link>
          </div>
        ),
      },
    ];

      return hideActions ? baseColumns.slice(0, -1) : baseColumns;
    },
    [hideActions, onStartReview],
  );

  const sortedRequests = useMemo(() => {
    if (!sorting.length) return requests;

    const sort = sorting[0];
    const sortAccessor = sort.id;
    const sorted = [...requests].sort((a, b) => {
      const aValue = a[sortAccessor as keyof VerificationRequestResponse];
      const bValue = b[sortAccessor as keyof VerificationRequestResponse];

      if (sortAccessor === "co2PerXLM") {
        const aNum = Number(a.co2PerXLM || 0);
        const bNum = Number(b.co2PerXLM || 0);
        return sort.desc ? bNum - aNum : aNum - bNum;
      }

      if (sortAccessor === "submittedAt") {
        const aTime = a.submittedAt ? new Date(a.submittedAt).getTime() : 0;
        const bTime = b.submittedAt ? new Date(b.submittedAt).getTime() : 0;
        return sort.desc ? bTime - aTime : aTime - bTime;
      }

      const aString = String(aValue ?? "").toLowerCase();
      const bString = String(bValue ?? "").toLowerCase();
      return sort.desc
        ? bString.localeCompare(aString)
        : aString.localeCompare(bString);
    });

    return sorted;
  }, [requests, sorting]);

  const table = useReactTable<VerificationRequestResponse>({
    data: sortedRequests,
    columns,
    state: {
      sorting,
    },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const sortedRows = table.getRowModel().rows;
  const startIndex = totalCount > 0 ? (page - 1) * pageSize + 1 : 0;
  const endIndex = Math.min(page * pageSize, totalCount);

  if (loading) {
    return <LoadingSkeleton />;
  }

  if (error) {
    return (
      <div className="card">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-semibold text-[var(--text)] font-body">
              Failed to load requests
            </p>
            <p className="text-sm text-[var(--text-secondary)] font-body">
              {error}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (requests.length === 0) {
    return (
      <div className="card text-center py-16">
        <span className="text-5xl block mb-4">📭</span>
        <h3 className="font-display font-semibold text-lg text-[var(--text)] mb-1">
          No verification requests match your filters
        </h3>
        <p className="text-sm text-[var(--text-secondary)] font-body">
          Adjust the status filter to see more requests.
        </p>
      </div>
    );
  }

  const activeSort = sorting[0];
  const renderSortIndicator = (columnId: string) => {
    if (activeSort?.id !== columnId) return "↕";
    return activeSort.desc ? "↓" : "↑";
  };

  return (
    <div className="space-y-4">
      <div className="overflow-x-auto rounded-2xl border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D] shadow-sm">
        <table className="min-w-full divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
          <thead>
            <tr className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
              {table.getFlatHeaders().map((header) => {
                const isSortable = header.column.getCanSort();
                const canSort = isSortable && header.id !== "actions";
                const activeSort = sorting.find((sort) => sort.id === header.column.id);
                const ariaSort =
                  activeSort?.desc === true
                    ? "descending"
                    : activeSort?.desc === false
                      ? "ascending"
                      : "none";
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={canSort ? ariaSort : undefined}
                    className={`px-6 py-4 text-left ${header.id === "projectCategory" ? "hidden md:table-cell" : ""} ${header.id === "submittedAt" ? "hidden lg:table-cell" : ""}`}
                  >
                    {canSort ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        className="flex items-center gap-2 text-left"
                        aria-label={`Sort by ${header.column.columnDef.header?.toString()}`}
                      >
                        <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                        <span aria-hidden="true">{renderSortIndicator(header.column.id)}</span>
                      </button>
                    ) : (
                      <span>{flexRender(header.column.columnDef.header, header.getContext())}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
            {sortedRows.map((row) => {
              const id = row.original.id;
              const isExpanded = expandedRows[id] ?? false;

              return (
                <Fragment key={id}>
                  <tr
                    className="group hover:bg-[rgba(99,102,241,0.02)] dark:hover:bg-[rgba(129,140,248,0.03)] transition-colors"
                  >
                    {row.getVisibleCells().map((cell) => {
                      const isMobileHidden =
                        cell.column.id === "projectCategory" ||
                        cell.column.id === "submittedAt";
                      return (
                        <td
                          key={cell.id}
                          className={`px-6 py-4 ${isMobileHidden ? "hidden md:table-cell" : ""} ${cell.column.id === "submittedAt" ? "hidden lg:table-cell" : ""}`}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      );
                    })}
                    <td className="px-6 py-4 md:hidden">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRows((prev) => ({
                            ...prev,
                            [id]: !prev[id],
                          }))
                        }
                        className="text-xs font-semibold text-[var(--primary)]"
                      >
                        {isExpanded ? "Hide details" : "Show details"}
                      </button>
                    </td>
                  </tr>
                  {isExpanded && (
                    <tr key={`${id}-details`} className="md:hidden">
                      <td colSpan={7} className="px-6 py-4 bg-[rgba(99,102,241,0.03)] dark:bg-[rgba(129,140,248,0.05)]">
                        <div className="space-y-2 text-sm text-[var(--text-secondary)] font-body">
                          <div>
                            <span className="font-semibold text-[var(--text)]">Project:</span>{" "}
                            {row.original.projectName}
                          </div>
                          <div>
                            <span className="font-semibold text-[var(--text)]">Category:</span>{" "}
                            {row.original.projectCategory}
                          </div>
                          <div>
                            <span className="font-semibold text-[var(--text)]">Submitted:</span>{" "}
                            {row.original.submittedAt ? formatDate(row.original.submittedAt) : "—"}
                          </div>
                          <div>
                            <span className="font-semibold text-[var(--text)]">CO₂ / XLM:</span>{" "}
                            {Math.round(Number(row.original.co2PerXLM || 0) * 100) / 100} g
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <p className="text-sm text-[var(--text-secondary)] font-body">
          Showing {startIndex}-{endIndex} of {totalCount}
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <label className="text-sm text-[var(--text-secondary)] font-body flex items-center gap-2">
            <span>Page size</span>
            <select
              aria-label="Page size"
              value={pageSize}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
              className="rounded-lg border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] bg-white dark:bg-[#14142D] px-3 py-1.5 text-sm"
            >
              <option value={10}>10</option>
              <option value={25}>25</option>
              <option value={50}>50</option>
            </select>
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onPageChange?.(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] disabled:opacity-40 transition-all font-body"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => onPageChange?.(page + 1)}
              disabled={endIndex >= totalCount}
              className="px-3 py-1.5 rounded-lg text-sm font-medium border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.14)] text-[var(--text-secondary)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] disabled:opacity-40 transition-all font-body"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
