/**
 * components/admin/VerificationTable.tsx
 *
 * Reusable verification requests table.
 *
 * Features:
 * - Sorting
 * - Filtering support through TanStack Table
 * - Responsive/mobile layout
 * - Pagination
 * - Loading state
 * - Error state
 * - Empty state
 * - Expandable mobile details
 */

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";

import {
  flexRender,
  getCoreRowModel,
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

/**
 * ---------------------------------------------------------
 * STATUS BADGE
 * ---------------------------------------------------------
 */

function StatusBadge({
  status,
}: {
  status: VerificationStatus;
}) {
  const label = STATUS_LABELS[status] || status;

  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold ${
        STATUS_COLORS[status] || STATUS_COLORS.pending
      }`}
    >
      {label}
    </span>
  );
}

/**
 * ---------------------------------------------------------
 * LOADING SKELETON
 * ---------------------------------------------------------
 */

function LoadingSkeleton() {
  return (
    <div className="w-full overflow-hidden rounded-2xl border border-[rgba(99,102,241,0.10)] bg-white shadow-sm dark:border-[rgba(129,140,248,0.14)] dark:bg-[#14142D]">
      <div className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
        {[1, 2, 3, 4, 5].map((i) => (
          <div
            key={i}
            className="flex items-center gap-4 px-6 py-4"
          >
            <div className="h-4 w-1/4 animate-pulse rounded bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)]" />

            <div className="h-4 w-1/5 animate-pulse rounded bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)]" />

            <div className="h-4 w-1/6 animate-pulse rounded bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)]" />

            <div className="h-4 w-1/6 animate-pulse rounded bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)]" />

            <div className="h-4 w-1/6 animate-pulse rounded bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.08)]" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * ---------------------------------------------------------
 * MAIN COMPONENT
 * ---------------------------------------------------------
 */

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

  const [expandedRows, setExpandedRows] = useState<
    Record<string, boolean>
  >({});

  /**
   * -------------------------------------------------------
   * COLUMNS
   * -------------------------------------------------------
   */

  const columns = useMemo<
    ColumnDef<VerificationRequestResponse>[]
  >(() => {
    const baseColumns: ColumnDef<VerificationRequestResponse>[] = [
      {
        accessorKey: "organizationName",
        id: "organizationName",
        header: "Organization",
        enableSorting: true,

        cell: ({ row }) => (
          <div className="min-w-[160px]">
            <Link
              href={`/admin/verification/${row.original.id}`}
              className="block"
            >
              <p className="text-sm font-semibold text-[var(--text)] transition-colors hover:text-[var(--primary)]">
                {row.original.organizationName}
              </p>

              {row.original.organizationCountry && (
                <p className="mt-0.5 text-xs text-[var(--muted)]">
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
          const icon =
            CATEGORY_ICONS[row.original.projectCategory] ||
            "🌿";

          return (
            <Link
              href={`/admin/verification/${row.original.id}`}
              className="block min-w-[150px]"
            >
              <p className="text-sm font-medium text-[var(--text)]">
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
          <span className="whitespace-nowrap text-sm text-[var(--text-secondary)]">
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
          const a = Number(
            rowA.getValue("co2PerXLM") || 0,
          );

          const b = Number(
            rowB.getValue("co2PerXLM") || 0,
          );

          return a - b;
        },

        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-[var(--text-secondary)]">
            {Math.round(
              Number(row.original.co2PerXLM || 0) * 100,
            ) / 100}{" "}
            g
          </span>
        ),
      },

      {
        accessorKey: "status",
        id: "status",
        header: "Status",
        enableSorting: true,

        cell: ({ row }) => (
          <StatusBadge
            status={row.original.status as VerificationStatus}
          />
        ),
      },

      {
        accessorKey: "submittedAt",
        id: "submittedAt",
        header: "Submitted",
        enableSorting: true,

        sortingFn: (rowA, rowB) => {
          const a = rowA.original.submittedAt
            ? new Date(
                rowA.original.submittedAt,
              ).getTime()
            : 0;

          const b = rowB.original.submittedAt
            ? new Date(
                rowB.original.submittedAt,
              ).getTime()
            : 0;

          return a - b;
        },

        cell: ({ row }) => (
          <span className="whitespace-nowrap text-sm text-[var(--text-secondary)]">
            {row.original.submittedAt
              ? formatDate(row.original.submittedAt)
              : "—"}
          </span>
        ),
      },

      {
        id: "actions",
        header: "Actions",
        enableSorting: false,

        cell: ({ row }) => (
          <div className="flex min-w-max items-center justify-end gap-2">
            {onStartReview &&
              row.original.status === "pending" && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();

                    onStartReview(row.original.id);
                  }}
                  className="whitespace-nowrap rounded-lg bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] px-3 py-1.5 text-xs font-semibold text-white transition-all hover:opacity-90"
                >
                  Start Review
                </button>
              )}

            <Link
              href={`/admin/verification/${row.original.id}`}
              className="whitespace-nowrap rounded-lg border border-[rgba(99,102,241,0.15)] px-3 py-1.5 text-xs font-semibold text-[var(--primary)] transition-all hover:bg-[rgba(99,102,241,0.06)] dark:border-[rgba(129,140,248,0.20)] dark:hover:bg-[rgba(129,140,248,0.08)]"
            >
              View Details
            </Link>
          </div>
        ),
      },
    ];

    return hideActions
      ? baseColumns.slice(0, -1)
      : baseColumns;
  }, [hideActions, onStartReview]);

  /**
   * -------------------------------------------------------
   * TABLE
   *
   * IMPORTANT:
   * Sorting is handled ONLY by TanStack Table.
   * -------------------------------------------------------
   */

  const table = useReactTable<VerificationRequestResponse>({
    data: requests,
    columns,

    state: {
      sorting,
    },

    onSortingChange: setSorting,

    getCoreRowModel: getCoreRowModel(),

    getSortedRowModel: getSortedRowModel(),

    manualPagination: true,
  });

  const rows = table.getRowModel().rows;

  /**
   * -------------------------------------------------------
   * PAGINATION
   * -------------------------------------------------------
   */

  const safePage = Math.max(1, page);

  const safePageSize = Math.max(1, pageSize);

  const safeTotalCount = Math.max(0, totalCount);

  const totalPages =
    safeTotalCount > 0
      ? Math.ceil(safeTotalCount / safePageSize)
      : 1;

  const startIndex =
    safeTotalCount > 0
      ? (safePage - 1) * safePageSize + 1
      : 0;

  const endIndex =
    safeTotalCount > 0
      ? Math.min(
          safePage * safePageSize,
          safeTotalCount,
        )
      : 0;

  const hasPreviousPage = safePage > 1;

  const hasNextPage = safePage < totalPages;

  /**
   * -------------------------------------------------------
   * LOADING
   * -------------------------------------------------------
   */

  if (loading) {
    return <LoadingSkeleton />;
  }

  /**
   * -------------------------------------------------------
   * ERROR
   * -------------------------------------------------------
   */

  if (error) {
    return (
      <div className="rounded-2xl border border-red-200 bg-white p-6 shadow-sm dark:border-red-900/40 dark:bg-[#14142D]">
        <div className="flex items-center gap-3">
          <span className="text-2xl">⚠️</span>

          <div>
            <p className="font-semibold text-[var(--text)]">
              Failed to load requests
            </p>

            <p className="mt-1 text-sm text-[var(--text-secondary)]">
              {error}
            </p>
          </div>
        </div>
      </div>
    );
  }

  /**
   * -------------------------------------------------------
   * EMPTY
   * -------------------------------------------------------
   */

  if (requests.length === 0) {
    return (
      <div className="rounded-2xl border border-[rgba(99,102,241,0.10)] bg-white py-16 text-center shadow-sm dark:border-[rgba(129,140,248,0.14)] dark:bg-[#14142D]">
        <span className="mb-4 block text-5xl">
          📭
        </span>

        <h3 className="mb-1 text-lg font-semibold text-[var(--text)]">
          No verification requests match your filters
        </h3>

        <p className="text-sm text-[var(--text-secondary)]">
          Adjust the status filter to see more requests.
        </p>
      </div>
    );
  }

  /**
   * -------------------------------------------------------
   * SORT INDICATOR
   * -------------------------------------------------------
   */

  const activeSort = sorting[0];

  const renderSortIndicator = (
    columnId: string,
  ) => {
    if (activeSort?.id !== columnId) {
      return "↕";
    }

    return activeSort.desc ? "↓" : "↑";
  };

  /**
   * -------------------------------------------------------
   * MAIN UI
   * -------------------------------------------------------
   */

  return (
    <div className="w-full space-y-4">
      {/* ===================================================
          TABLE
          =================================================== */}

      <div className="w-full overflow-hidden rounded-2xl border border-[rgba(99,102,241,0.10)] bg-white shadow-sm dark:border-[rgba(129,140,248,0.14)] dark:bg-[#14142D]">
        <div className="w-full overflow-x-auto overscroll-x-contain">
          <table className="min-w-[900px] w-full divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
            <thead>
              <tr className="text-xs font-semibold uppercase tracking-wider text-[var(--muted)]">
                {table
                  .getFlatHeaders()
                  .map((header) => {
                    const isSortable =
                      header.column.getCanSort();

                    const canSort =
                      isSortable &&
                      header.id !== "actions";

                    const currentSort =
                      sorting.find(
                        (sort) =>
                          sort.id ===
                          header.column.id,
                      );

                    const ariaSort =
                      currentSort?.desc === true
                        ? "descending"
                        : currentSort?.desc ===
                            false
                          ? "ascending"
                          : "none";

                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          canSort
                            ? ariaSort
                            : undefined
                        }
                        className={`whitespace-nowrap px-6 py-4 text-left ${
                          header.id ===
                          "projectCategory"
                            ? "hidden md:table-cell"
                            : ""
                        } ${
                          header.id ===
                          "submittedAt"
                            ? "hidden lg:table-cell"
                            : ""
                        }`}
                      >
                        {canSort ? (
                          <button
                            type="button"
                            onClick={header.column.getToggleSortingHandler()}
                            className="inline-flex items-center gap-2 whitespace-nowrap text-left"
                            aria-label={`Sort by ${String(
                              header.column
                                .columnDef
                                .header ?? "",
                            )}`}
                          >
                            <span>
                              {flexRender(
                                header.column
                                  .columnDef
                                  .header,
                                header.getContext(),
                              )}
                            </span>

                            <span aria-hidden="true">
                              {renderSortIndicator(
                                header.column.id,
                              )}
                            </span>
                          </button>
                        ) : (
                          <span>
                            {flexRender(
                              header.column
                                .columnDef
                                .header,
                              header.getContext(),
                            )}
                          </span>
                        )}
                      </th>
                    );
                  })}
              </tr>
            </thead>

            <tbody className="divide-y divide-[rgba(99,102,241,0.06)] dark:divide-[rgba(129,140,248,0.06)]">
              {rows.map((row) => {
                const id = row.original.id;

                const isExpanded =
                  expandedRows[id] ?? false;

                return (
                  <Fragment key={id}>
                    <tr className="group transition-colors hover:bg-[rgba(99,102,241,0.02)] dark:hover:bg-[rgba(129,140,248,0.03)]">
                      {row
                        .getVisibleCells()
                        .map((cell) => {
                          const isMobileHidden =
                            cell.column.id ===
                              "projectCategory" ||
                            cell.column.id ===
                              "submittedAt";

                          return (
                            <td
                              key={cell.id}
                              className={`px-6 py-4 ${
                                isMobileHidden
                                  ? "hidden md:table-cell"
                                  : ""
                              } ${
                                cell.column.id ===
                                "submittedAt"
                                  ? "hidden lg:table-cell"
                                  : ""
                              }`}
                            >
                              {flexRender(
                                cell.column
                                  .columnDef.cell,
                                cell.getContext(),
                              )}
                            </td>
                          );
                        })}

                      {/* Mobile details */}
                      <td className="px-6 py-4 md:hidden">
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedRows(
                              (previous) => ({
                                ...previous,
                                [id]: !previous[id],
                              }),
                            )
                          }
                          className="whitespace-nowrap text-xs font-semibold text-[var(--primary)]"
                        >
                          {isExpanded
                            ? "Hide details"
                            : "Show details"}
                        </button>
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr className="md:hidden">
                        <td
                          colSpan={
                            table.getVisibleLeafColumns()
                              .length + 1
                          }
                          className="bg-[rgba(99,102,241,0.03)] px-6 py-4 dark:bg-[rgba(129,140,248,0.05)]"
                        >
                          <div className="space-y-2 text-sm text-[var(--text-secondary)]">
                            <div>
                              <span className="font-semibold text-[var(--text)]">
                                Project:
                              </span>{" "}
                              {
                                row.original
                                  .projectName
                              }
                            </div>

                            <div>
                              <span className="font-semibold text-[var(--text)]">
                                Category:
                              </span>{" "}
                              {
                                row.original
                                  .projectCategory
                              }
                            </div>

                            <div>
                              <span className="font-semibold text-[var(--text)]">
                                Status:
                              </span>{" "}
                              <StatusBadge
                                status={
                                  row.original
                                    .status as VerificationStatus
                                }
                              />
                            </div>

                            <div>
                              <span className="font-semibold text-[var(--text)]">
                                Submitted:
                              </span>{" "}
                              {row.original.submittedAt
                                ? formatDate(
                                    row.original
                                      .submittedAt,
                                  )
                                : "—"}
                            </div>

                            <div>
                              <span className="font-semibold text-[var(--text)]">
                                CO₂ / XLM:
                              </span>{" "}
                              {Math.round(
                                Number(
                                  row.original
                                    .co2PerXLM || 0,
                                ) * 100,
                              ) / 100}{" "}
                              g
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
      </div>

      {/* ===================================================
          PAGINATION

          IMPORTANT:
          No z-index.
          No isolate.
          No relative stacking context.

          This is deliberately a separate sibling from the
          table overflow container.
          =================================================== */}

      <div className="flex w-full flex-col gap-3 md:flex-row md:items-center md:justify-between">
        {/* Result count */}

        <p className="shrink-0 text-sm text-[var(--text-secondary)]">
          Showing {startIndex}-{endIndex} of{" "}
          {safeTotalCount}
        </p>

        {/* Controls */}

        <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
          {/* Page size */}

          <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
            <span>Page size</span>

            <select
              aria-label="Page size"
              value={safePageSize}
              onChange={(event) => {
                const nextPageSize = Number(
                  event.target.value,
                );

                onPageSizeChange?.(
                  nextPageSize,
                );

                onPageChange?.(1);
              }}
              className="cursor-pointer rounded-lg border border-[rgba(99,102,241,0.10)] bg-white px-3 py-1.5 text-sm text-[var(--text)] outline-none dark:border-[rgba(129,140,248,0.14)] dark:bg-[#14142D]"
            >
              <option value={10}>10</option>

              <option value={25}>25</option>

              <option value={50}>50</option>
            </select>
          </label>

          {/* Pagination */}

          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Previous"
              disabled={!hasPreviousPage}
              onClick={() => {
                if (!hasPreviousPage) {
                  return;
                }

                onPageChange?.(
                  safePage - 1,
                );
              }}
              className="inline-flex min-h-[36px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[rgba(99,102,241,0.10)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition-all hover:bg-[rgba(99,102,241,0.04)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[rgba(129,140,248,0.14)] dark:bg-[#14142D] dark:hover:bg-[rgba(129,140,248,0.06)]"
            >
              Previous
            </button>

            <button
              type="button"
              aria-label="Next"
              disabled={!hasNextPage}
              onClick={() => {
                if (!hasNextPage) {
                  return;
                }

                onPageChange?.(
                  safePage + 1,
                );
              }}
              className="inline-flex min-h-[36px] shrink-0 cursor-pointer items-center justify-center rounded-lg border border-[rgba(99,102,241,0.10)] bg-white px-3 py-1.5 text-sm font-medium text-[var(--text-secondary)] transition-all hover:bg-[rgba(99,102,241,0.04)] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[rgba(129,140,248,0.14)] dark:bg-[#14142D] dark:hover:bg-[rgba(129,140,248,0.06)]"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}