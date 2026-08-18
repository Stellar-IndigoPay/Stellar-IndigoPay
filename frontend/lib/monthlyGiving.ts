/**
 * lib/monthlyGiving.ts — On-chain recurring donation subscriptions (#81).
 *
 * Thin client for the Soroban contract's subscription entry points:
 * reading a single subscription, enumerating due subscriptions for a
 * donor across the whole subscription list, and the create/cancel
 * sign-and-submit flows via the connected wallet.
 */
import {
  Account,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
} from "@stellar/stellar-sdk";
import {
  server,
  rpcServer,
  NETWORK_PASSPHRASE,
  CONTRACT_ID,
  submitSorobanTransaction,
} from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";

/** ~1 day at 5s/ledger — the contract's minimum allowed subscription interval. */
export const MIN_SUBSCRIPTION_INTERVAL_LEDGERS = 17280;

/** Stroops per whole XLM (7 decimal places). */
const STROOPS_PER_XLM = BigInt(10_000_000);

export interface OnChainSubscription {
  donor: string;
  projectId: string;
  amountXLM: string;
  intervalLedgers: number;
  nextExecutionLedger: number;
  active: boolean;
  createdAtLedger: number;
}

export interface CreateMonthlySubscriptionParams {
  donor: string;
  projectId: string;
  amountXLM: string;
  intervalLedgers?: number;
}

export interface CreateMonthlySubscriptionResult {
  subscription: OnChainSubscription | null;
  error: string | null;
}

export interface CancelMonthlySubscriptionResult {
  success: boolean;
  error: string | null;
}

function formatStroopsToXLM(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  return `${whole}.${frac.toString().padStart(7, "0")}`;
}

/** Maps a raw on-chain subscription record to our camelCase shape. */
function decodeSubscription(raw: any): OnChainSubscription {
  const amountStroops =
    typeof raw.amount === "bigint" ? raw.amount : BigInt(raw.amount);
  return {
    donor: raw.donor,
    projectId: raw.project_id,
    amountXLM: formatStroopsToXLM(amountStroops),
    intervalLedgers: Number(raw.interval_ledgers),
    nextExecutionLedger: Number(raw.next_execution),
    active: Boolean(raw.active),
    createdAtLedger: Number(raw.created_at),
  };
}

/**
 * Maps a Soroban simulation failure's raw host-error text to a friendly,
 * user-facing message. Shared by create/cancel since each only ever
 * triggers the branch relevant to its own contract entry point.
 */
function friendlySimulationError(rawError: string | undefined): string {
  const msg = rawError ?? "";
  if (/already exists/i.test(msg)) {
    return "You already have an active subscription for this project.";
  }
  if (/not found/i.test(msg)) {
    return "No subscription was found for this project.";
  }
  return "Something went wrong while contacting the network. Please try again.";
}

/**
 * Simulates a read-only contract call. `sourceAccountId` only needs to be
 * a syntactically valid account — simulation doesn't require it to be
 * funded or to match any real signer.
 */
async function simulateReadCall(
  sourceAccountId: string,
  method: string,
  args: unknown[],
) {
  const account = new Account(sourceAccountId, "0");
  const contract = new Contract(CONTRACT_ID);
  const op = contract.call(method, ...args.map((a) => nativeToScVal(a)));
  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(op)
    .setTimeout(30)
    .build();
  return rpcServer.simulateTransaction(tx);
}

/** Reads a single donor+project subscription, or null if none exists. */
export async function getMonthlySubscription(
  donor: string,
  projectId: string,
): Promise<OnChainSubscription | null> {
  try {
    const sim = await simulateReadCall(donor, "get_subscription", [
      donor,
      projectId,
    ]);
    if (!rpc.Api.isSimulationSuccess(sim)) return null;
    const raw = scValToNative((sim as any).result.retval);
    if (!raw) return null;
    return decodeSubscription(raw);
  } catch {
    return null;
  }
}

/**
 * Enumerates every subscription on the contract and returns only the ones
 * belonging to `donor` that are active and due (next_execution has
 * already passed). A single unreadable index is skipped rather than
 * aborting the whole scan.
 */
export async function getDueMonthlySubscriptionsForDonor(
  donor: string,
): Promise<OnChainSubscription[]> {
  const due: OnChainSubscription[] = [];
  try {
    const countSim = await simulateReadCall(
      donor,
      "get_subscription_count",
      [],
    );
    if (!rpc.Api.isSimulationSuccess(countSim)) return due;
    const count = Number(scValToNative((countSim as any).result.retval));

    const { sequence: currentLedger } = await rpcServer.getLatestLedger();

    for (let i = 0; i < count; i++) {
      try {
        const sim = await simulateReadCall(donor, "get_subscription_by_index", [
          i,
        ]);
        if (!rpc.Api.isSimulationSuccess(sim)) continue;
        const raw = scValToNative((sim as any).result.retval);
        if (!raw) continue;

        const sub = decodeSubscription(raw);
        if (
          sub.donor === donor &&
          sub.active &&
          sub.nextExecutionLedger <= currentLedger
        ) {
          due.push(sub);
        }
      } catch {
        continue;
      }
    }
  } catch {
    return due;
  }
  return due;
}

/**
 * Builds, simulates, signs (via the connected wallet), and submits a
 * `create_subscription` call, then refetches the resulting subscription.
 */
export async function createMonthlySubscription({
  donor,
  projectId,
  amountXLM,
  intervalLedgers = MIN_SUBSCRIPTION_INTERVAL_LEDGERS,
}: CreateMonthlySubscriptionParams): Promise<CreateMonthlySubscriptionResult> {
  try {
    const account = await server.loadAccount(donor);
    const amountStroops = BigInt(
      Math.round(Number.parseFloat(amountXLM) * 10_000_000),
    );

    const contract = new Contract(CONTRACT_ID);
    const op = contract.call(
      "create_subscription",
      nativeToScVal(donor),
      nativeToScVal(projectId),
      nativeToScVal(amountStroops),
      nativeToScVal(intervalLedgers),
    );

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await rpcServer.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      return {
        subscription: null,
        error: friendlySimulationError((sim as any).error),
      };
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    const preparedXDR = prepared.toXDR();

    const { signedXDR, error: signError } =
      await signTransactionWithWallet(preparedXDR);
    if (signError || !signedXDR) {
      return { subscription: null, error: signError || "Signing failed." };
    }

    await submitSorobanTransaction(signedXDR);

    const subscription = await getMonthlySubscription(donor, projectId);
    return { subscription, error: null };
  } catch (err) {
    return {
      subscription: null,
      error:
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
    };
  }
}

/**
 * Builds, simulates, signs (via the connected wallet), and submits a
 * `cancel_subscription` call.
 */
/**
 * Legacy compatibility shim: the pre-migration localStorage-based
 * subscription model tracked a client-side "paid" flag per subscription.
 * On-chain, that state lives entirely on the contract (next_execution /
 * active), updated when the recurring donation actually executes, so
 * there's nothing for the client to persist here. Kept as a no-op purely
 * so existing call sites (e.g. pages/projects/[id].tsx) keep compiling.
 */
export async function markMonthlySubscriptionPaid(
  _subscriptionId: string,
  _amountXLM: string,
): Promise<void> {
  return;
}

export async function cancelMonthlySubscription(
  donor: string,
  projectId: string,
): Promise<CancelMonthlySubscriptionResult> {
  try {
    const account = await server.loadAccount(donor);
    const contract = new Contract(CONTRACT_ID);
    const op = contract.call(
      "cancel_subscription",
      nativeToScVal(donor),
      nativeToScVal(projectId),
    );

    const tx = new TransactionBuilder(account, {
      fee: "100",
      networkPassphrase: NETWORK_PASSPHRASE,
    })
      .addOperation(op)
      .setTimeout(30)
      .build();

    const sim = await rpcServer.simulateTransaction(tx);
    if (!rpc.Api.isSimulationSuccess(sim)) {
      return { success: false, error: friendlySimulationError((sim as any).error) };
    }

    const prepared = rpc.assembleTransaction(tx, sim).build();
    const preparedXDR = prepared.toXDR();

    const { signedXDR, error: signError } =
      await signTransactionWithWallet(preparedXDR);
    if (signError || !signedXDR) {
      return { success: false, error: signError || "Signing failed." };
    }

    await submitSorobanTransaction(signedXDR);

    return { success: true, error: null };
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error
          ? err.message
          : "Something went wrong. Please try again.",
    };
  }
}
