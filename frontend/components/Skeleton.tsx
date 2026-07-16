/**
 * components/Skeleton.tsx — Systematic Skeleton Loading System
 *
 * Reusable building blocks for loading placeholders.
 * All primitives use the design system's color tokens (forest, indigo) and
 * respect dark mode. Every skeleton implements `animate-pulse` + pointer-events-none
 * to prevent interaction while loading.
 *
 * Usage:
 *   <SkeletonBox className="w-10 h-10 rounded-xl" />
 *   <SkeletonText lines={3} />
 *   <SkeletonCard />
 *   <SkeletonStatCard />
 */

import React from "react";

// ── Shared helpers ────────────────────────────────────────────────────────────

/**
 * Common tailwind classes applied to every skeleton element.
 * The accent palette (forest‑green) is used because the majority of the app
 * uses the forest design tokens.  Individual skeletons can override with
 * the `indigo` variant via the `palette` prop.
 */
const skeletonBase =
  "animate-pulse pointer-events-none select-none";

const paletteMap = {
  forest: {
    bg: "bg-forest-100",
    bgLight: "bg-forest-50",
    border: "border-forest-200",
  },
  indigo: {
    bg: "bg-[rgba(99,102,241,0.10)] dark:bg-[rgba(129,140,248,0.12)]",
    bgLight: "bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)]",
    border: "border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]",
  },
};

export type SkeletonPalette = "forest" | "indigo";

function paletteClass(
  palette: SkeletonPalette,
  key: "bg" | "bgLight" | "border",
) {
  return paletteMap[palette][key];
}

// ── Primitives ────────────────────────────────────────────────────────────────

interface SkeletonBoxProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** Generic rectangular / rounded skeleton block. */
export function SkeletonBox({
  className = "",
  palette = "forest",
}: SkeletonBoxProps) {
  return (
    <div
      className={`${skeletonBase} ${paletteClass(palette, "bg")} ${className}`}
    />
  );
}

interface SkeletonTextProps {
  /** Number of text lines to render. */
  lines?: number;
  /** CSS width of each line.  Defaults to alternating widths for realism. */
  widths?: string[];
  className?: string;
  palette?: SkeletonPalette;
}

/** Multi-line paragraph skeleton. */
export function SkeletonText({
  lines = 3,
  widths,
  className = "",
  palette = "forest",
}: SkeletonTextProps) {
  const paletteBg = paletteClass(palette, "bg");
  const paletteBgLight = paletteClass(palette, "bgLight");

  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => {
        const w =
          widths?.[i] ??
          (i === lines - 1
            ? "w-2/3"
            : i % 2 === 0
              ? "w-full"
              : "w-3/4");
        const bg = i % 2 === 0 ? paletteBg : paletteBgLight;
        return (
          <div
            key={i}
            className={`${skeletonBase} h-3 rounded-full ${w} ${bg}`}
          />
        );
      })}
    </div>
  );
}

interface SkeletonAvatarProps {
  size?: "sm" | "md" | "lg";
  className?: string;
  palette?: SkeletonPalette;
}

const avatarSizes = {
  sm: "w-8 h-8",
  md: "w-10 h-10",
  lg: "w-16 h-16",
};

/** Circular avatar skeleton. */
export function SkeletonAvatar({
  size = "md",
  className = "",
  palette = "forest",
}: SkeletonAvatarProps) {
  return (
    <div
      className={`${skeletonBase} ${avatarSizes[size]} rounded-full ${paletteClass(palette, "bg")} border ${paletteClass(palette, "border")} ${className}`}
    />
  );
}

interface SkeletonBadgeProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** Small rounded pill / badge skeleton. */
export function SkeletonBadge({
  className = "",
  palette = "forest",
}: SkeletonBadgeProps) {
  return (
    <div
      className={`${skeletonBase} h-5 rounded-full w-16 ${paletteClass(palette, "bgLight")} ${className}`}
    />
  );
}

interface SkeletonProgressBarProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** Full-width progress bar skeleton. */
export function SkeletonProgressBar({
  className = "",
  palette = "forest",
}: SkeletonProgressBarProps) {
  return (
    <div className={`${className}`}>
      <div className="flex justify-between mb-2">
        <div
          className={`${skeletonBase} h-2 rounded-full w-1/4 ${paletteClass(palette, "bgLight")}`}
        />
        <div
          className={`${skeletonBase} h-2 rounded-full w-1/3 ${paletteClass(palette, "bgLight")}`}
        />
      </div>
      <div
        className={`${skeletonBase} h-2.5 rounded-full w-full ${paletteClass(palette, "bg")}`}
      />
    </div>
  );
}

// ── Composite skeletons ───────────────────────────────────────────────────────

interface SkeletonCardProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** Full card skeleton matching the project's `.card` visual style. */
export function SkeletonCard({
  className = "",
  palette = "forest",
}: SkeletonCardProps) {
  return (
    <div
      className={`card ${skeletonBase} flex flex-col h-full border ${paletteClass(palette, "border")} shadow-none ${className}`}
    >
      {/* Header row: avatar + badges */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <SkeletonAvatar size="md" palette={palette} />
          <div className="space-y-1.5">
            <SkeletonBox
              className="h-2.5 rounded-full w-16"
              palette={palette}
            />
            <SkeletonBox
              className="h-2 rounded-full w-20"
              palette={palette}
            />
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <SkeletonBadge palette={palette} />
          <SkeletonBadge className="w-12" palette={palette} />
        </div>
      </div>

      {/* Title + description */}
      <SkeletonText
        lines={3}
        widths={["w-3/4", "w-1/2", "w-2/3"]}
        className="mb-5 flex-1"
        palette={palette}
      />

      {/* Progress bar */}
      <SkeletonProgressBar className="mb-5" palette={palette} />

      {/* Stats row */}
      <div
        className={`flex items-center justify-between pt-3 border-t ${paletteClass(palette, "border")}`}
      >
        <div className="flex items-center gap-4">
          <SkeletonBox className="h-3 rounded-full w-14" palette={palette} />
          <SkeletonBox className="h-3 rounded-full w-16" palette={palette} />
        </div>
        <SkeletonBox className="h-3 rounded-full w-12" palette={palette} />
      </div>
    </div>
  );
}

interface SkeletonStatCardProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** Stat card skeleton for dashboard/impact grids. */
export function SkeletonStatCard({
  className = "",
  palette = "indigo",
}: SkeletonStatCardProps) {
  return (
    <div
      className={`card rounded-3xl p-8 ${skeletonBase} border ${paletteClass(palette, "border")} ${className}`}
    >
      <SkeletonBox className="w-12 h-12 rounded-2xl mb-6" palette={palette} />
      <SkeletonBox className="h-3 rounded-full w-1/2 mb-3" palette={palette} />
      <SkeletonBox className="h-8 rounded-full w-24" palette={palette} />
    </div>
  );
}

interface SkeletonTableRowProps {
  /** Whether to show an avatar/rank column (e.g. for leaderboards). */
  withAvatar?: boolean;
  className?: string;
  palette?: SkeletonPalette;
}

/** A single row skeleton for tables and feeds. */
export function SkeletonTableRow({
  withAvatar = true,
  className = "",
  palette = "indigo",
}: SkeletonTableRowProps) {
  return (
    <div
      className={`${skeletonBase} flex items-center gap-4 p-4 rounded-xl border ${paletteClass(palette, "border")} ${paletteClass(palette, "bgLight")} ${className}`}
    >
      {withAvatar && (
        <SkeletonAvatar size="sm" palette={palette} />
      )}
      <div className="flex-1 space-y-2">
        <SkeletonBox
          className="h-3 rounded w-1/3"
          palette={palette}
        />
        <SkeletonBox
          className="h-2 rounded w-1/4"
          palette={palette}
        />
      </div>
      <SkeletonBox className="h-4 rounded w-20" palette={palette} />
    </div>
  );
}

interface SkeletonListProps {
  /** Number of rows to show. Default 5. */
  rows?: number;
  withAvatar?: boolean;
  className?: string;
  palette?: SkeletonPalette;
}

/** List of table-row skeletons. */
export function SkeletonList({
  rows = 5,
  withAvatar = true,
  className = "",
  palette = "indigo",
}: SkeletonListProps) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonTableRow
          key={i}
          withAvatar={withAvatar}
          palette={palette}
        />
      ))}
    </div>
  );
}

interface SkeletonPageHeaderProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** Simple page header skeleton (title + subtitle). */
export function SkeletonPageHeader({
  className = "",
  palette = "forest",
}: SkeletonPageHeaderProps) {
  return (
    <div className={`mb-8 ${className}`}>
      <SkeletonBox
        className="h-8 rounded w-1/3 mb-2"
        palette={palette}
      />
      <SkeletonBox
        className="h-4 rounded w-1/2"
        palette={palette}
      />
    </div>
  );
}

interface SkeletonDonationRowProps {
  className?: string;
  palette?: SkeletonPalette;
}

/** A donation history row skeleton. */
export function SkeletonDonationRow({
  className = "",
  palette = "indigo",
}: SkeletonDonationRowProps) {
  return (
    <div
      className={`${skeletonBase} h-16 rounded-xl ${paletteClass(palette, "bgLight")} ${className}`}
    />
  );
}

interface SkeletonDonationListProps {
  rows?: number;
  className?: string;
  palette?: SkeletonPalette;
}

/** Multiple donation history row skeletons. */
export function SkeletonDonationList({
  rows = 3,
  className = "",
  palette = "indigo",
}: SkeletonDonationListProps) {
  return (
    <div className={`space-y-3 ${className}`}>
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonDonationRow key={i} palette={palette} />
      ))}
    </div>
  );
}
