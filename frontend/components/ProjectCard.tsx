/**
 * components/ProjectCard.tsx
 */
import Image from "next/image";
import Link from "next/link";
import { motion } from "framer-motion";
import type { ClimateProject } from "@/utils/types";
import {
  formatXLM,
  formatCO2,
  progressPercent,
  statusClass,
  statusLabel,
  CATEGORY_ICONS,
} from "@/utils/format";
import CircularProgress from "./CircularProgress";
import { useXlmPrice } from "@/lib/priceContext";
import { useWishlist } from "@/hooks/useWishlist";
import ProjectProgressBar from "./ProjectProgressBar";
import { SkeletonCard } from "./Skeleton";
import { useI18n } from "@/lib/i18n";

export default function ProjectCard({ project }: { project: ClimateProject }) {
  const { t, tPlural } = useI18n();
  const pct = progressPercent(project.raisedXLM, project.goalXLM);
  const isComplete = pct >= 100;
  const xlmUsd = useXlmPrice();
  const { toggleWishlist, isInWishlist } = useWishlist();
  const isWishlisted = isInWishlist(project.id);

  return (
    <div className="relative group" data-testid="project-card">
      <Link
        href={`/projects/${project.id}`}
        className="card-hover group animate-fade-in flex flex-col h-full relative overflow-hidden focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0A0A1A]"
        aria-label={`View project: ${project.name}`}
      >
        <motion.div
          whileTap={{ scale: 0.98 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
          className="flex flex-col h-full relative overflow-hidden"
        >
          {/* Project image — next/image for optimized loading */}
          {project.imageUrl && (
            <div className="relative w-full h-48 -mx-6 -mt-6 mb-4 overflow-hidden">
              <Image
                src={project.imageUrl}
                alt={`${project.name} project photo`}
                fill
                sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
                className="object-cover"
                loading="lazy"
              />
            </div>
          )}
          {/* Category icon + badges */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-10 h-10 rounded-xl bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-xl border border-[rgba(99,102,241,0.12)] dark:border-[rgba(129,140,248,0.15)]">
                {CATEGORY_ICONS[project.category] || "🌿"}
              </div>
              <div>
                <p className="text-xs text-[#475569] dark:text-[#94A3B8] font-body">
                  {project.category}
                </p>
                <p className="text-xs text-[#64748B] dark:text-[#64748B] font-body">
                  {project.location}
                </p>
              </div>
          </div>
          <div className="flex items-center gap-1.5">
            {isComplete ? (
              <span className="badge text-xs px-3 py-1 rounded-full bg-gradient-to-r from-emerald-500 to-emerald-600 text-white border-2 border-white shadow-md font-body font-bold">
                ✅ {t("project.fullyFunded")}
              </span>
            ) : (
              <>
                {project.onChainVerified ? (
                  <span className="badge-indigo text-[10px] px-2 py-0.5 font-body font-bold shadow-sm">
                    {t("project.onChainVerified")}
                  </span>
                ) : project.verified ? (
                  <span className="badge-verified text-xs px-2 py-0.5 font-body">
                    ✓ {t("project.verified")}
                  </span>
                ) : null}
                <span className={statusClass(project.status)}>
                  {statusLabel(project.status)}
                </span>
              </>
            )}
          </div>
        </div>

        {/* Name & description */}
        <h3 className="font-display font-semibold text-[#0F172A] dark:text-[#E2E8F0] text-base leading-snug mb-2 group-hover:text-[#4F46E5] dark:group-hover:text-[#818CF8] transition-colors line-clamp-2">
          {project.name}
        </h3>
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm leading-relaxed line-clamp-3 mb-4 flex-1 font-body">
          {project.description}
        </p>

        {/* Progress */}
        <div className="mb-4">
          {isComplete ? (
            <div className="bg-gradient-to-r from-green-500 to-emerald-600 text-white px-4 py-2 rounded-lg text-center text-sm font-semibold shadow-sm">
              ✅ {t("project.fullyFunded")}
            </div>
          ) : (
            <div className="space-y-2">
              <ProjectProgressBar
                raisedXLM={project.raisedXLM}
                goalXLM={project.goalXLM}
                className="w-full"
              />
              <div className="flex items-center justify-between text-[11px] text-[#8aaa8a] font-body">
                <span>{formatXLM(project.raisedXLM)} {t("project.raised")}</span>
                <span>
                  {project.goalXLM && Number(project.goalXLM) > 0
                    ? `${t("project.goal")}: ${formatXLM(project.goalXLM)}`
                    : t("project.noGoalSet")}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Stats row */}
        <div className="flex items-center justify-between pt-3 border-t border-[rgba(99,102,241,0.07)] dark:border-[rgba(129,140,248,0.07)]">
          <div className="flex items-center gap-3 text-xs text-[#475569] dark:text-[#94A3B8] font-body">
            <span>👥 {tPlural("donor.count", project.donorCount)}</span>
            <span className="flex items-center gap-1">
              ♻️ {formatCO2(project.co2OffsetKg)}
              <span className="tooltip">
                <span
                  role="img"
                  aria-label="CO₂ offset estimate methodology info"
                  className="w-3.5 h-3.5 flex items-center justify-center rounded-full bg-[rgba(99,102,241,0.08)] text-[8px] text-[#4F46E5] dark:text-[#818CF8] border border-[rgba(99,102,241,0.15)]"
                >
                  ℹ️
                </span>
                <span className="tooltip-text">
                  {t("project.estimatedCO2Info")}
                </span>
              </span>
            </span>
          </div>
          </div>
          <span
            className="text-xs font-semibold text-[#4F46E5] dark:text-[#818CF8] font-body group-hover:text-[#6366F1]"
            aria-hidden="true"
          >
            {t("project.donate")}
          </span>
        </motion.div>
      </Link>

      {/* Wishlist Toggle — SIBLING of the <a>, NOT nested, so it is valid HTML. */}
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          toggleWishlist(project.id);
        }}
        aria-pressed={isWishlisted}
        aria-label={
          isWishlisted
            ? `Remove ${project.name} from wishlist`
            : `Add ${project.name} to wishlist`
        }
        className={`absolute top-4 right-4 p-2.5 rounded-xl border transition-all duration-300 transform hover:scale-110 active:scale-95 z-20 shadow-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[#818CF8] focus-visible:ring-offset-2 dark:focus-visible:ring-offset-[#0A0A1A] ${
          isWishlisted
            ? "bg-red-50 text-red-500 border-red-200 opacity-100"
            : "bg-white/90 text-forest-300 border-forest-100 hover:text-red-400 hover:border-red-100 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        }`}
      >
        <svg
          className={`w-5 h-5 transition-all duration-300 ${isWishlisted ? "fill-current" : "fill-none"}`}
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z"
          />
        </svg>
      </button>
    </div>
  );
}

export function ProjectCardSkeleton() {
  return (
    <SkeletonCard palette="forest" className="border-[rgba(34,114,57,0.06)]" />
  );
}
