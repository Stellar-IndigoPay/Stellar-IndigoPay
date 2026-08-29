/**
 * components/TransactionPreview.tsx
 *
 * Workstream 5 — "No blind signing".  Before the wallet prompt appears the
 * donor reviews exactly what they are signing: destination, amount,
 * estimated network fee, and total debited.  A confirmation checkbox gates
 * the sign action, and an aria-live region announces the summary to screen
 * readers (Workstream 7).
 */
import { useState, useEffect } from "react";
import type { SimulationResult } from "@/lib/stellar";
import { shortenAddressForPreview, NETWORK } from "@/lib/stellar";
import { formatXLM } from "@/utils/format";

interface TransactionPreviewProps {
  simulation: SimulationResult;
  projectName: string;
  onConfirm: () => void;
  onBack: () => void;
  busy?: boolean;
}

export default function TransactionPreview({
  simulation,
  projectName,
  onConfirm,
  onBack,
  busy = false,
}: TransactionPreviewProps) {
  const [acknowledged, setAcknowledged] = useState(false);
  // Workstream 7: the aria-live region MOUNTS EMPTY and receives the
  // announcement via an effect after render.  A live region that mounts with
  // its content already present is often not announced by screen readers
  // (the region "appears" together with the text), so the post-render update
  // is what reliably fires the polite announcement.
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement(
      `You are donating ${simulation.amount} ${simulation.currency} to ${projectName}. Network fee ${simulation.feeXLM}.`,
    );
  }, [simulation, projectName]);

  const networkLabel = NETWORK === "mainnet" ? "Mainnet" : "Testnet";

  return (
    <div className="animate-fade-in" data-testid="transaction-preview">
      {/* Screen-reader announcement of the simulation result. */}
      <p className="sr-only" aria-live="polite" data-testid="preview-live-region">
        {announcement}
      </p>

      <div className="rounded-2xl border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] p-4 space-y-3">
        <h4 className="font-display text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
          Review your donation
        </h4>

        <dl className="space-y-2 text-sm font-body">
          <div className="flex items-center justify-between gap-4">
            <dt className="text-[#475569] dark:text-[#94A3B8]">Donating</dt>
            <dd
              className="font-semibold text-[#0F172A] dark:text-[#E2E8F0]"
              data-testid="preview-amount"
            >
              {simulation.currency === "XLM"
                ? formatXLM(parseFloat(simulation.amount))
                : `${parseFloat(simulation.amount).toFixed(2)} USDC`}
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-[#475569] dark:text-[#94A3B8]">To</dt>
            <dd
              className="font-mono text-xs text-[#0F172A] dark:text-[#E2E8F0]"
              data-testid="preview-destination"
              title={simulation.destination}
            >
              {shortenAddressForPreview(simulation.destination)}
              {/* The truncated cell must still expose the COMPLETE address to
                  assistive tech — a visually hidden span, not just the title
                  attribute (which screen readers do not reliably announce). */}
              <span className="sr-only">{simulation.destination}</span>
            </dd>
          </div>

          <div className="flex items-center justify-between gap-4">
            <dt className="text-[#475569] dark:text-[#94A3B8]">Network fee (est.)</dt>
            <dd
              className="text-[#0F172A] dark:text-[#E2E8F0]"
              data-testid="preview-fee"
            >
              {simulation.feeXLM} XLM
              <span className="ml-1 text-xs text-[#475569] dark:text-[#94A3B8]">
                ({simulation.feeStroops.toLocaleString()} stroops)
              </span>
            </dd>
          </div>

          {simulation.totalDebited !== null && (
            <div className="flex items-center justify-between gap-4 border-t border-[rgba(99,102,241,0.12)] dark:border-[rgba(129,140,248,0.15)] pt-2">
              <dt className="font-medium text-[#0F172A] dark:text-[#E2E8F0]">
                Total debited from wallet
              </dt>
              <dd
                className="font-semibold text-[#4F46E5] dark:text-[#818CF8]"
                data-testid="preview-total"
              >
                {formatXLM(parseFloat(simulation.totalDebited))}
              </dd>
            </div>
          )}

          <div className="flex items-center justify-between gap-4">
            <dt className="text-[#475569] dark:text-[#94A3B8]">Network</dt>
            <dd className="text-[#0F172A] dark:text-[#E2E8F0]">{networkLabel}</dd>
          </div>
        </dl>

        <p className="text-xs text-[#475569] dark:text-[#94A3B8] font-body">
          100% of the donation amount goes to{" "}
          <span className="font-medium text-[#0F172A] dark:text-[#E2E8F0]">
            {projectName}
          </span>
          . The network fee is paid by you and goes to the Stellar network.
        </p>
      </div>

      <label className="mt-4 flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(e) => setAcknowledged(e.target.checked)}
          className="mt-0.5 w-4 h-4 rounded text-[#4F46E5] focus:ring-[#4F46E5] border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800"
          data-testid="preview-confirm-checkbox"
        />
        <span className="text-sm text-[#0F172A] dark:text-[#E2E8F0] font-body">
          I have reviewed these details and understand what I am signing.
        </span>
      </label>

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="flex-1 px-4 py-2.5 rounded-xl border border-[rgba(99,102,241,0.20)] dark:border-[rgba(129,140,248,0.25)] text-[#4F46E5] dark:text-[#818CF8] font-medium text-sm font-body hover:bg-[rgba(99,102,241,0.06)] dark:hover:bg-[rgba(129,140,248,0.08)] transition-colors disabled:opacity-50"
        >
          Back
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!acknowledged || busy}
          className="flex-1 px-4 py-2.5 rounded-xl btn-primary text-white font-medium text-sm font-body disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="preview-confirm-button"
        >
          {busy ? "Signing…" : "Confirm & Sign"}
        </button>
      </div>
    </div>
  );
}
