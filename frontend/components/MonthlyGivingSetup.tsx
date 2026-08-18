import { useEffect, useMemo, useRef, useState } from "react";
import {
  createMonthlySubscription,
  cancelMonthlySubscription,
  getMonthlySubscription,
  MIN_SUBSCRIPTION_INTERVAL_LEDGERS,
  type OnChainSubscription,
} from "@/lib/monthlyGiving";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { formatXLM, timeAgo } from "@/utils/format";
import type { MonthlySubscription } from "@/utils/types";

interface MonthlyGivingSetupProps {
  projectId: string;
  projectName: string;
  /** Connected donor wallet public key — same prop shape as DonateForm. */
  publicKey: string;
  onClose: () => void;
  onCreated?: () => void;
}

/**
 * ~30 days at 5s/ledger. On-chain subscriptions (#81) don't have a
 * separate "monthly" concept in the contract — this is just the interval
 * this UI passes to `create_subscription` for a monthly cadence. A donor
 * wanting a different cadence isn't supported by this dialog.
 */
const MONTHLY_INTERVAL_LEDGERS = MIN_SUBSCRIPTION_INTERVAL_LEDGERS * 30;

export default function MonthlyGivingSetup({
  projectId,
  projectName,
  publicKey,
  onClose,
  onCreated,
}: MonthlyGivingSetupProps) {
  const [amountXLM, setAmountXLM] = useState("25");
  const [subscription, setSubscription] = useState<OnChainSubscription | null>(
    null,
  );
  const [loadingSubscription, setLoadingSubscription] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  // Trap focus while the dialog is open and Esc closes it (WCAG 2.4.3).
  // The containerRef MUST be attached to the dialog wrapper so the hook's
  // focusable-element query targets the actual modal subtree.
  const dialogRef = useFocusTrap<HTMLDivElement>({
    active: true,
    onEscape: onClose,
    initialFocusRef: closeButtonRef,
  });

  // Prevent body scroll while the dialog is open.
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  // Read the current on-chain subscription (if any) for this donor +
  // project as soon as the dialog opens.
  useEffect(() => {
    let cancelled = false;
    setLoadingSubscription(true);
    getMonthlySubscription(publicKey, projectId).then((sub) => {
      if (!cancelled) {
        setSubscription(sub);
        setLoadingSubscription(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [publicKey, projectId]);

  const canCreate = useMemo(() => {
    const amount = Number.parseFloat(amountXLM);
    return Number.isFinite(amount) && amount >= 1;
  }, [amountXLM]);

  const handleCreate = async () => {
    if (!canCreate) {
      setError("Enter a valid amount.");
      return;
    }
    setError(null);
    setBusy(true);
    const { subscription: created, error: createError } =
      await createMonthlySubscription({
        donor: publicKey,
        projectId,
        amountXLM: Number.parseFloat(amountXLM).toFixed(7),
        intervalLedgers: MONTHLY_INTERVAL_LEDGERS,
      });
    setBusy(false);
    if (createError || !created) {
      setError(createError || "Could not create the subscription.");
      return;
    }
    setSubscription(created);
    onCreated?.();
    onClose();
  };

  const handleCancel = async () => {
    setError(null);
    setBusy(true);
    const { success, error: cancelError } = await cancelMonthlySubscription(
      publicKey,
      projectId,
    );
    setBusy(false);
    if (!success) {
      setError(cancelError || "Could not cancel the subscription.");
      return;
    }
    setSubscription((prev) => (prev ? { ...prev, active: false } : prev));
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="monthly-giving-setup-title"
        className="w-full max-w-xl card bg-white dark:bg-[#14142D] max-h-[90vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between mb-4">
          <h3
            id="monthly-giving-setup-title"
            className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0]"
          >
            Monthly Giving Setup
          </h3>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="btn-secondary text-xs py-1.5 px-3"
            aria-label="Close monthly giving setup"
          >
            Close
          </button>
        </div>

        <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body mb-5">
          Schedule recurring monthly donations for{" "}
          <strong>{projectName}</strong>.
        </p>

        {loadingSubscription ? (
          <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
            Checking your subscription status&hellip;
          </p>
        ) : subscription?.active ? (
          <div className="p-3 rounded-lg border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)]">
            <p className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] font-body">
              {formatXLM(subscription.amountXLM)} monthly &middot; Active
            </p>
            <p className="text-xs text-[#64748B] dark:text-[#94A3B8] font-body mt-1">
              Next reminder at ledger {subscription.nextExecutionLedger}
            </p>

            {error && (
              <p className="mt-3 text-sm text-red-600 font-body" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={handleCancel}
              disabled={busy}
              className="btn-secondary w-full mt-4 disabled:opacity-60"
            >
              {busy ? "Cancelling\u2026" : "Cancel monthly giving"}
            </button>
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="amount-xlm" className="label">
                Amount (XLM)
              </label>
              <input
                id="amount-xlm"
                type="number"
                min="1"
                step="1"
                value={amountXLM}
                onChange={(e) => setAmountXLM(e.target.value)}
                className="input-field"
              />
            </div>

            {error && (
              <p className="mt-3 text-sm text-red-600 font-body" role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              onClick={handleCreate}
              disabled={!canCreate || busy}
              className="btn-primary w-full mt-5 disabled:opacity-60"
            >
              {busy ? "Confirm in wallet\u2026" : "Save Monthly Giving"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
