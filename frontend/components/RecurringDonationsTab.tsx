/**
 * components/RecurringDonationsTab.tsx
 *
 * Renders the donor's active and inactive on-chain recurring donations.
 * Allows trustless cancellation on-chain.
 */
import { useState, useEffect } from "react";
import {
  buildCancelRecurringTransaction,
  submitTransaction,
  explorerUrl,
  CONTRACT_ID,
} from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";
import { formatXLM } from "@/utils/format";

interface RecurringDonation {
  id: string;
  donorAddress: string;
  recurringId: number;
  projectId: string;
  projectName: string;
  projectWallet: string;
  amount: number;
  currency: string;
  intervalSeconds: number;
  nextExecutionAt: string;
  keeperIncentive: number;
  active: boolean;
  createdAt: string;
}

interface RecurringDonationsTabProps {
  publicKey: string;
}

export default function RecurringDonationsTab({ publicKey }: RecurringDonationsTabProps) {
  const [recurringDonations, setRecurringDonations] = useState<RecurringDonation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<number | null>(null);
  const [cancelStatus, setCancelStatus] = useState<string | null>(null);

  const fetchRecurring = async () => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "";
      const res = await fetch(`${apiUrl}/api/donations/recurring/${publicKey}`);
      const data = await res.json();
      if (data.success) {
        setRecurringDonations(data.data);
      } else {
        throw new Error(data.error || "Failed to load recurring donations");
      }
    } catch (err: any) {
      setError(err.message || "An error occurred fetching recurring donations");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (publicKey) {
      fetchRecurring();
    }
  }, [publicKey]);

  const handleCancel = async (recurringId: number) => {
    if (!CONTRACT_ID) {
      alert("Contract ID is not configured.");
      return;
    }
    const confirmCancel = confirm("Are you sure you want to cancel this recurring donation schedule?");
    if (!confirmCancel) return;

    setCancellingId(recurringId);
    setCancelStatus("Building cancellation transaction...");

    try {
      const tx = await buildCancelRecurringTransaction({
        contractId: CONTRACT_ID,
        donor: publicKey,
        recurringId,
      });

      setCancelStatus("Awaiting wallet signature...");
      const { signedXDR, error: signErr } = await signTransactionWithWallet(tx.toXDR());
      if (signErr || !signedXDR) {
        throw new Error(signErr || "Signing transaction failed");
      }

      setCancelStatus("Submitting cancellation to Stellar network...");
      await submitTransaction(signedXDR);

      setCancelStatus("Cancellation successfully processed!");
      setTimeout(() => {
        setCancellingId(null);
        setCancelStatus(null);
        fetchRecurring();
      }, 2000);
    } catch (err: any) {
      alert(`Failed to cancel recurring donation: ${err.message || "Unknown error"}`);
      setCancellingId(null);
      setCancelStatus(null);
    }
  };

  const getFrequencyLabel = (seconds: number) => {
    if (seconds <= 120960 * 5) return "Weekly";
    if (seconds <= 518400 * 5) return "Monthly";
    return "Quarterly";
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-sm text-[#475569] dark:text-[#94A3B8]">Loading recurring donation schedules...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 text-red-600 rounded-xl text-sm font-body">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-slide-up focus:outline-none">
      <div className="card shadow-sm border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]">
        <h2 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-5 flex items-center gap-2">
          <span>📅</span> On-Chain Recurring Donations
        </h2>

        {recurringDonations.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-4xl mb-3">📅</p>
            <p className="text-[#475569] dark:text-[#94A3B8] font-body text-sm">
              You have no active recurring donation schedules.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {recurringDonations.map((sub) => (
              <div
                key={sub.id}
                className="flex flex-col md:flex-row md:items-center justify-between gap-4 p-5 rounded-xl bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border border-[rgba(99,102,241,0.08)] dark:border-[rgba(129,140,248,0.10)]"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-[#0F172A] dark:text-[#E2E8F0] text-base">
                      {sub.projectName}
                    </h3>
                    <span
                      className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                        sub.active
                          ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400"
                          : "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {sub.active ? "Active" : "Cancelled"}
                    </span>
                  </div>
                  <p className="text-sm text-[#475569] dark:text-[#94A3B8] font-body">
                    Amount: <span className="font-semibold text-gradient">{sub.amount} {sub.currency}</span> / {getFrequencyLabel(sub.intervalSeconds)}
                  </p>
                  {sub.active && (
                    <p className="text-xs text-gray-500 font-body">
                      Next execution: {new Date(sub.nextExecutionAt).toLocaleDateString()} (approx)
                    </p>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  {sub.active && (
                    <button
                      onClick={() => handleCancel(sub.recurringId)}
                      disabled={cancellingId !== null}
                      className="px-4 py-2 text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 dark:bg-red-950/20 dark:hover:bg-red-950/30 border border-red-200 dark:border-red-900/30 rounded-xl transition-all disabled:opacity-50"
                    >
                      {cancellingId === sub.recurringId ? cancelStatus || "Cancelling..." : "Cancel Schedule"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
