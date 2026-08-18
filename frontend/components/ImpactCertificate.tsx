import { useMemo } from "react";
import {
  badgeEmoji,
  badgeLabel,
  formatCO2,
  formatDate,
  formatXLM,
  shortenAddress,
} from "@/utils/format";
import type { BadgeTier } from "@/utils/types";
import { useI18n } from "@/lib/i18n";

export default function ImpactCertificate(props: {
  donorAddress: string;
  donorName?: string | null;
  totalDonatedXLM: string;
  totalCO2OffsetKg: number;
  badgeTier: BadgeTier | null;
  projectsSupported: Array<{ id: string; name: string }>;
}) {
  const { t } = useI18n();
  const {
    donorAddress,
    donorName,
    totalDonatedXLM,
    totalCO2OffsetKg,
    badgeTier,
    projectsSupported,
  } = props;

  const issuedDate = useMemo(() => formatDate(new Date().toISOString()), []);

  return (
    <div
      id="impact-certificate"
      className="bg-white dark:bg-[#14142D] border border-[rgba(99,102,241,0.12)] dark:border-[rgba(129,140,248,0.15)] rounded-3xl overflow-hidden shadow-lg"
    >
      <div className="card-gradient px-8 py-8">
        <div className="flex items-center justify-between gap-6">
          <div>
            <p className="text-xs tracking-[0.22em] uppercase text-[#A5B4FC] font-body">
              Stellar-IndigoPay
            </p>
            <h2 className="font-display text-3xl font-bold leading-tight text-white">
              {t("certificate.title")}
            </h2>
            <p className="text-[#C7D2FE] text-sm mt-2 font-body">
              {t("certificate.subtitle")}
            </p>
          </div>
          <div className="w-16 h-16 rounded-2xl bg-white/10 backdrop-blur-sm border border-white/20 flex items-center justify-center text-3xl">
            🌿
          </div>
        </div>
      </div>

      <div className="px-8 py-8">
        <div className="text-center mb-8">
          <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
            {t("certificate.presentedTo")}
          </p>
          <p className="font-display text-3xl font-bold text-[#0F172A] dark:text-[#E2E8F0] mt-2">
            {donorName?.trim() ? donorName : shortenAddress(donorAddress)}
          </p>
          <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-2 font-body">
            {t("certificate.donorAddress", { address: shortenAddress(donorAddress, 10) })}
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
          <div className="card text-center border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
            <div className="w-12 h-12 rounded-xl bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-2xl mx-auto mb-3">
              💚
            </div>
            <p className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] text-lg">
              {formatXLM(totalDonatedXLM)}
            </p>
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-1 font-body uppercase tracking-wider font-bold opacity-60">
              {t("certificate.totalDonated")}
            </p>
          </div>
          <div className="card text-center border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
            <div className="w-12 h-12 rounded-xl bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-2xl mx-auto mb-3">
              ♻️
            </div>
            <p className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] text-lg">
              {formatCO2(totalCO2OffsetKg)}
            </p>
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-1 font-body uppercase tracking-wider font-bold opacity-60">
              {t("certificate.co2Offset")}
            </p>
          </div>
          <div className="card text-center border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
            <div className="w-12 h-12 rounded-xl bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] flex items-center justify-center text-2xl mx-auto mb-3">
              {badgeTier ? badgeEmoji(badgeTier) : "🏅"}
            </div>
            <p className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] text-lg">
              {badgeTier ? badgeLabel(badgeTier) : t("certificate.supporter")}
            </p>
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8] mt-1 font-body uppercase tracking-wider font-bold opacity-60">
              {t("certificate.badgeTier")}
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] p-5">
          <h3 className="font-display font-bold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
            {t("certificate.projectsSupported")}
          </h3>
          {projectsSupported.length === 0 ? (
            <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
              Your supported projects will appear here after your first
              donation.
            </p>
          ) : (
            <ul className="text-sm text-[#0F172A] dark:text-[#E2E8F0] font-body grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1">
              {projectsSupported.slice(0, 8).map((p) => (
                <li key={p.id} className="flex items-center gap-2">
                  <span className="text-[#4F46E5] dark:text-[#818CF8]">•</span>
                  <span className="font-semibold">{p.name}</span>
                </li>
              ))}
            </ul>
          )}
          {projectsSupported.length > 8 && (
            <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-2 font-body">
              +{projectsSupported.length - 8} more
            </p>
          )}
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mt-8 pt-6 border-t border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
          <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
            Issued on {issuedDate}
          </p>
          <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
            Verified by on-chain donation history
          </p>
        </div>
      </div>
    </div>
  );
}
