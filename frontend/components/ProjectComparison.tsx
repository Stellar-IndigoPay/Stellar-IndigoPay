import Link from "next/link";
import { Fragment, useMemo, useState } from "react";
import { formatCO2, formatXLM, formatNumber, progressPercent } from "@/utils/format";
import type { ClimateProject } from "@/utils/types";

interface ProjectComparisonProps {
  projects: ClimateProject[];
  onClose: () => void;
}

const ROWS = [
  { key: "co2", label: "CO2 per XLM" },
  { key: "progress", label: "Progress %" },
  { key: "donorCount", label: "Donor count" },
  { key: "goal", label: "Goal" },
  { key: "raised", label: "Raised" },
  { key: "status", label: "Status" },
  { key: "verified", label: "Verified" },
] as const;

export default function ProjectComparison({
  projects,
  onClose,
}: ProjectComparisonProps) {
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const shareUrl = useMemo(() => {
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    url.searchParams.set(
      "compare",
      projects.map((project) => project.id).join(","),
    );
    return url.toString();
  }, [projects]);

  const handleCopyLink = async () => {
    if (!shareUrl) return;
    await navigator.clipboard.writeText(shareUrl);
    setCopyState("copied");
    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-6xl card bg-white max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
            Project Comparison
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleCopyLink}
              className="btn-secondary text-xs py-1.5 px-3"
            >
              {copyState === "copied" ? "Copied URL" : "Share URL"}
            </button>
            <button
              onClick={onClose}
              className="btn-secondary text-xs py-1.5 px-3"
            >
              Close
            </button>
          </div>
        </div>

        <div
          className="grid gap-4"
          style={{
            gridTemplateColumns: `150px repeat(${projects.length}, minmax(180px, 1fr))`,
          }}
        >
          <div className="font-body text-xs uppercase tracking-widest text-[#64748B] dark:text-[#94A3B8]">
            Metric
          </div>
          {projects.map((project) => (
            <div
              key={`${project.id}-header`}
              className="p-3 rounded-lg bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]"
            >
              <p className="font-display text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
                {project.name}
              </p>
              <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-1 font-body">
                {project.category}
              </p>
            </div>
          ))}

          {ROWS.map((row) => (
            <Fragment key={row.key}>
              <div className="font-body text-sm text-[#475569] dark:text-[#94A3B8] py-2 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
                {row.label}
              </div>
              {projects.map((project) => {
                const pct = progressPercent(project.raisedXLM, project.goalXLM);
                const co2PerXLM =
                  Number.parseFloat(project.goalXLM) > 0
                    ? project.co2OffsetKg / Number.parseFloat(project.goalXLM)
                    : 0;
                let value = "";
                if (row.key === "co2") value = `${co2PerXLM.toFixed(2)} kg`;
                if (row.key === "progress") value = `${pct}%`;
                if (row.key === "donorCount")
                  value = formatNumber(project.donorCount);
                if (row.key === "goal") value = formatXLM(project.goalXLM);
                if (row.key === "raised") value = formatXLM(project.raisedXLM);
                if (row.key === "status") value = project.status;
                if (row.key === "verified")
                  value = project.verified ? "Yes" : "No";

                return (
                  <div
                    key={`${project.id}-${row.key}`}
                    className="py-2 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
                  >
                    <p className="font-body text-sm text-[#0F172A] dark:text-[#E2E8F0]">
                      {value}
                    </p>
                    {row.key === "raised" && (
                      <p className="font-body text-xs text-[#64748B] dark:text-[#94A3B8] mt-1">
                        {formatCO2(project.co2OffsetKg)} offset
                      </p>
                    )}
                  </div>
                );
              })}
            </Fragment>
          ))}

          <div className="pt-3 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]" />
          {projects.map((project) => (
            <div
              key={`${project.id}-actions`}
              className="pt-3 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
            >
              <Link
                href={`/projects/${project.id}`}
                className="btn-primary text-sm py-2 px-4 inline-flex items-center justify-center w-full"
              >
                Donate
              </Link>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
