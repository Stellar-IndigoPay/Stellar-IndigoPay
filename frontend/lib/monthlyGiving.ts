/**
 * lib/monthlyGiving.ts — Recurring donation client
 *
 * Reads/writes subscriptions through the backend API instead of localStorage.
 * Legacy MonthlySubscription type is kept for backward compatibility with the
 * dashboard UI; the actual data is synced from the RecurringDonation on-chain
 * state via the backend.
 */
import type { MonthlySubscription, RecurringDonation } from "@/utils/types";
import {
  fetchRecurringDonations,
  createRecurringDonation,
  cancelRecurringDonation,
} from "@/lib/api";

function addMonths(isoDate: string, months: number) {
  const date = new Date(isoDate);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const maxDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, maxDay));
  return date.toISOString();
}

function toMonthlySubscription(
  rd: RecurringDonation,
  projectName?: string,
): MonthlySubscription {
  const ledgerIntervalSecs = rd.interval_ledgers * 5; // 5s per ledger
  const intervalMs = ledgerIntervalSecs * 1000;
  const now = new Date();
  const nextDueDate = new Date(now.getTime() + intervalMs);

  return {
    id: String(rd.subscription_id),
    projectId: rd.project_id,
    projectName: projectName || rd.project_id,
    amountXLM: (Number(rd.amount_stroops) / 10_000_000).toFixed(7),
    startDate: new Date(
      Date.now() - intervalMs * (rd.remaining_payments || 1),
    ).toISOString(),
    durationMonths: rd.remaining_payments,
    nextDueDate: nextDueDate.toISOString(),
    remainingMonths: rd.remaining_payments,
    status: rd.active ? "active" : "completed",
    createdAt: rd.created_at,
    history: [],
  };
}

export async function loadMonthlySubscriptions(
  donorAddress?: string,
): Promise<MonthlySubscription[]> {
  if (!donorAddress) return [];
  try {
    const subs = await fetchRecurringDonations(donorAddress);
    return subs.map((s) => toMonthlySubscription(s));
  } catch {
    return [];
  }
}

export async function saveMonthlySubscriptions(
  _subscriptions: MonthlySubscription[],
) {
  // No-op: subscriptions are managed via the API.
  // This function exists for backward compatibility with existing callers.
}

export async function createMonthlySubscription(
  donorAddress: string,
  input: {
    projectId: string;
    projectName?: string;
    amountXLM: string;
    startDate: string;
    durationMonths: number | null;
  },
) {
  const amountNum = Number(input.amountXLM);
  const amountStroops = Math.floor(amountNum * 10_000_000);
  const intervalLedgers = 432_000; // ~30 days
  const maxPayments = input.durationMonths || 12;

  const result = await createRecurringDonation({
    donorAddress,
    projectId: input.projectId,
    amount: amountStroops,
    intervalLedgers,
    maxPayments,
  });

  return result;
}

export async function markMonthlySubscriptionPaid(
  _subscriptionId: string,
  _amountXLM: string,
) {
  // No-op: the backend cron handles this.
}

export async function getDueMonthlySubscriptions(donorAddress?: string) {
  if (!donorAddress) return [];
  const now = new Date();
  try {
    const subs = await fetchRecurringDonations(donorAddress);
    return subs
      .filter((s) => s.active)
      .map((s) => toMonthlySubscription(s))
      .filter((sub) => new Date(sub.nextDueDate).getTime() <= now.getTime());
  } catch {
    return [];
  }
}
