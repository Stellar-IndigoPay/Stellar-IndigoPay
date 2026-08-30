/**
 * components/DonateForm.tsx
 * Donation form for a climate project.
 */
import FormField from "@/components/FormField";
import { useFormValidation } from "@/hooks/useFormValidation";
import { donationSchema } from "@/lib/validation/schemas";
import { useState, useEffect, useRef } from "react";
import {
  buildDonationTransaction,
  buildContractDonationTransaction,
  buildCreateRecurringTransaction,
  buildApproveTransaction,
  submitTransaction,
  explorerUrl,
  getAccountSummary,
  getBaseReserveXLM,
  getAssetBalance,
  getDonorStats,
  hashMessage,
  CONTRACT_ID,
  estimateFeeStroops,
  calculateMaxDonation,
  calculateMinimumReserveXLM,
  BASE_RESERVE_XLM,
  formatFeeXLM,
  stroopsToXLM,
  simulateDonation,
  pollTransaction,
  type SimulationResult,
} from "@/lib/stellar";
import { Asset, Transaction } from "@stellar/stellar-sdk";
import { signTransactionWithWallet } from "@/lib/wallet";
import { useRecordDonation } from "@/hooks/queries";
import useOnlineStatus from "@/hooks/useOnlineStatus";
import { queueDonation } from "@/lib/offlineDonationQueue";
import { formatXLM, formatCO2, formatUSDEquivalent } from "@/utils/format";
import { trackEvent } from "@/lib/analytics";
import { safeRandomUUID } from "@/utils/uuid";
import { encryptMessage } from "@/lib/encryption";
import { usePriceContext } from "@/lib/priceContext";
import { PriceStaleIndicator } from "@/components/PriceStaleIndicator";
import TransactionPreview from "@/components/TransactionPreview";
import { ENABLE_DONATION_V2 } from "@/lib/featureFlags";
import type { ClimateProject } from "@/utils/types";
import type { DonorAsset, ConversionEstimate } from "@/lib/dex";

interface DonateFormProps {
  project: ClimateProject;
  publicKey: string;
  initialAmount?: string;
  initialMessage?: string;
  onSuccess?: () => void;
}

type Step =
  | "idle"
  | "building"
  | "preview"
  | "signing"
  | "submitting"
  | "polling"
  | "recording"
  | "success"
  | "unknown"
  | "error";

function isDonationProcessingError(error: unknown): boolean {
  return error instanceof Error && error.name === "DonationProcessingError";
}

const PRESETS_XLM = ["10", "25", "50", "100", "250"];
const PRESETS_USDC = ["5", "10", "25", "50", "100"];

const FREQUENCY_LEDGERS: Record<string, number> = {
  weekly: 120960,
  monthly: 518400,
  quarterly: 1555200,
};

export default function DonateForm({
  project,
  publicKey,
  initialAmount,
  initialMessage,
  onSuccess,
}: DonateFormProps) {
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  // Private message flag (from main): flagged messages are encrypted with the
  // project's public key before they leave the browser.
  const [isPrivateMessage, setIsPrivateMessage] = useState(false);
  const [currency, setCurrency] = useState<"XLM" | "USDC">("XLM");
  const [isRecurring, setIsRecurring] = useState<boolean>(false);
  const [frequency, setFrequency] = useState<"weekly" | "monthly" | "quarterly">("monthly");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  // Workstream 5: the simulated transaction shown in the preview step.
  const [simulation, setSimulation] = useState<SimulationResult | null>(null);
  // Workstream 6: wallet rejections are a cancel, not an error — show a
  // dismissible notice instead of an error banner.
  const [cancelNotice, setCancelNotice] = useState<string | null>(null);
  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
  // Workstream 1: the account's true minimum reserve, (2 + subentries) × the
  // live Stellar base reserve — the Max button must leave this intact.
  const [reserveXLM, setReserveXLM] = useState<number>(BASE_RESERVE_XLM);
  const [trustlineMissing, setTrustlineMissing] = useState<boolean>(false);
  const [donorBadge, setDonorBadge] = useState<string | null>(null);
  // DEX path-payment state
  const [donorAssets, setDonorAssets] = useState<DonorAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<DonorAsset | null>(null);
  const [conversionEstimate, setConversionEstimate] =
    useState<ConversionEstimate | null>(null);
  const [conversionLoading, setConversionLoading] = useState(false);
  const [conversionError, setConversionError] = useState<string | null>(null);
  const isOnline = useOnlineStatus();
  const recordDonationMutation = useRecordDonation();
  const { xlmUsd, isStale, isDegraded, priceAgeMs } = usePriceContext();

  useEffect(() => {
    if (!initialAmount) return;
    setAmount(initialAmount);
  }, [initialAmount]);

  useEffect(() => {
    if (!initialMessage) return;
    setMessage(initialMessage);
  }, [initialMessage]);

  // Track a refresh counter so we can trigger balance re-fetch after
  // a successful transaction without depending on publicKey/currency
  // changing (which they don't after a donation).
  const [balanceRefreshKey, setBalanceRefreshKey] = useState(0);

  const refreshBalances = () => setBalanceRefreshKey((k) => k + 1);

  // Workstream 7: when the donation reaches a terminal state (confirmed,
  // queued, or unknown), move focus to the result heading so screen-reader
  // users land on the outcome instead of being left silently in the form.
  const resultHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step !== "success" && step !== "unknown") return;
    const timer = window.setTimeout(() => {
      resultHeadingRef.current?.focus({ preventScroll: false });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [step]);

  // Workstream 7: the preview branch replaces the form subtree, so move
  // focus to its heading when it first appears (step === "preview") — screen
  // readers land on the review step instead of being left in the form.
  // Subsequent steps (signing/submitting/polling) keep the branch mounted and
  // must NOT steal focus back from the controls the donor is using.
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (step !== "preview") return;
    const timer = window.setTimeout(() => {
      previewHeadingRef.current?.focus({ preventScroll: false });
    }, 50);
    return () => window.clearTimeout(timer);
  }, [step]);

  useEffect(() => {
    let mounted = true;
    async function loadBalances() {
      if (!publicKey) return;
      try {
        const summary = await getAccountSummary(publicKey);
        const baseReserve = await getBaseReserveXLM();
        if (!mounted) return;
        setXlmBalance(summary.balance);
        // Accounts with trustlines, signers, offers, or sponsored entries owe
        // more than the bare 2-XLM minimum — compute the real reserve from
        // Horizon's subentry + sponsorship counts × the live base reserve.
        setReserveXLM(
          calculateMinimumReserveXLM(
            summary.subentries,
            summary.numSponsoring,
            baseReserve,
          ),
        );
        if (currency === "USDC") {
          const issuer = process.env.NEXT_PUBLIC_USDC_ISSUER;
          if (!issuer) {
            setUsdcBalance(null);
            setTrustlineMissing(true);
            return;
          }
          const usdc = await getAssetBalance(publicKey, "USDC", issuer);
          if (!mounted) return;
          setUsdcBalance(usdc);
          setTrustlineMissing(usdc === null);
        } else {
          setUsdcBalance(null);
          setTrustlineMissing(false);
        }
      } catch (err) {
        // ignore balance fetch errors; leave values as null
      }
    }

    loadBalances();
    // Workstream 1: real-time balance polling so the Max button and
    // insufficient-balance validation stay accurate while the form is open.
    const pollTimer = setInterval(loadBalances, 10_000);
    return () => {
      mounted = false;
      clearInterval(pollTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, currency, balanceRefreshKey]);

  // Workstream 6: if a previous visit ended in the "unknown" state (a
  // transaction was submitted but never confirmed before the tab closed),
  // restore the persisted hash so the donor can check the explorer.
  useEffect(() => {
    if (!ENABLE_DONATION_V2) return;
    if (typeof window === "undefined") return;
    try {
      const pending = window.sessionStorage.getItem("indigopay-unknown-tx");
      if (pending) {
        setTxHash(pending);
        setStep("unknown");
      }
    } catch {
      // sessionStorage may be unavailable (private browsing) — ignore.
    }
  }, []);

  const { errors, validate, clearField } = useFormValidation(donationSchema);
  const [validationAnnouncement, setValidationAnnouncement] = useState<string>("");

  // Announce the first validation error to screen reader users whenever the
  // error map changes (e.g. after clicking "Donate" with invalid input).
  // Visual error text is already shown inline via role="alert", but that
  // alone isn't reliably announced for fields like the amount input which
  // rely on aria-invalid rather than a wrapping FormField.
  useEffect(() => {
    const errorValues = Object.values(errors).filter(
      (value): value is string => Boolean(value),
    );
    setValidationAnnouncement(errorValues.length > 0 ? errorValues[0] : "");
  }, [errors]);

  const amountNum = parseFloat(amount);
  const isValid = donationSchema.safeParse({
    amount,
    message: message || undefined,
    projectId: project.id,
  }).success;

  // ── Workstream 1: fee estimate, Max button, and balance validation ──
  const feeStroops = estimateFeeStroops(1);
  const balanceNum =
    xlmBalance !== null ? parseFloat(xlmBalance) : null;
  const usdcBalanceNum =
    usdcBalance !== null ? parseFloat(usdcBalance) : null;

  // Max safe donation: balance − reserve − fee − 1 stroop margin.  The
  // reserve is the account's true minimum ((2 + subentries) × live base
  // reserve), not a fixed 2 XLM.
  const maxDonationXLM =
    balanceNum !== null && balanceNum > 0
      ? calculateMaxDonation(balanceNum, reserveXLM, feeStroops)
      : "0";
  const maxDonationNum = parseFloat(maxDonationXLM);

  // Insufficient balance: the submit gate must agree with the Max button —
  // for XLM the spendable amount is balance − reserve − fee − 1 stroop, so
  // anything above the computed maximum is rejected up front instead of being
  // signed and then refused by Horizon for falling below the base reserve.
  const amountExceedsBalance =
    amountNum > 0
      ? currency === "XLM"
        ? balanceNum !== null && amountNum > maxDonationNum
        : usdcBalanceNum !== null && amountNum > usdcBalanceNum
      : false;
  const balanceErrorMessage =
    amountExceedsBalance && amountNum > 0
      ? currency === "XLM"
        ? `Insufficient balance (${maxDonationNum.toFixed(2)} XLM available after the ${reserveXLM.toFixed(2)} XLM account reserve and network fee)`
        : `Insufficient balance (${usdcBalanceNum!.toFixed(2)} USDC available)`
      : null;

  const canSubmit =
    isValid && !amountExceedsBalance && step === "idle";

  // Calculate CO₂ impact for XLM donations
  const co2Impact =
    currency === "XLM" && amount && !isNaN(amountNum) && project.co2_per_xlm
      ? (amountNum * project.co2_per_xlm) / 1000 // Convert to kg
      : 0;

  // Calculate tree equivalent (rough estimate: 1 tree absorbs ~22kg CO₂ per year)
  const treeEquivalent = co2Impact > 0 ? Math.round(co2Impact / 22) : 0;

  const charCount = message.length;

  const getCounterColor = () => {
    // Dark-mode variants keep the counter at WCAG AA contrast on the dark
    // card (issue #1096, WS7 — e.g. #4F46E5 on #14142D is only 2.9:1).
    if (charCount >= 96) return "text-red-500 dark:text-red-400";
    if (charCount >= 80) return "text-amber-500 dark:text-amber-400";
    return "text-[#4F46E5] dark:text-[#818CF8]";
  };

  // Draining the offline queue lives in the app-level useOfflineQueueSync
  // hook (_app.tsx) — a single routine for load / reconnect / service-worker
  // nudges, with the idempotency pre-check, conflict toast, and confirmation
  // notification.  The cross-tab drain lease keeps the queue exactly-once, so
  // a duplicate per-form drain would only add nondeterministic feedback.

  // The build parameters are kept between the preview step and the confirm
  // step so the transaction is REBUILT fresh at confirm time — the donor
  // reviews the exact destination/amount/fee, while the sequence number and
  // 60s time bound start at confirmation, so a slow reader can never sign a
  // stale transaction (tx_too_late).
  const pendingParamsRef = useRef<{
    fromPublicKey: string;
    toPublicKey: string;
    amount: string;
    memo: string;
    asset?: { code: string; issuer?: string };
  } | null>(null);
  // The idempotency key generated when the donation flow started is kept
  // alongside so the confirm step (and any offline retry) records with the
  // SAME key — never regenerated, so the server can dedupe a retry of a
  // donation that actually went through before the connection dropped.
  const pendingIdempotencyRef = useRef<string | null>(null);
  // The encrypted-message outcome computed when the flow started, carried
  // across the preview/confirm/sign/submit steps (which live in separate
  // closures) so the recorded/queued donation always carries the SAME message
  // payload — plain or encrypted — that the donor approved.
  const pendingMessageRef = useRef<{ message?: string; encrypted: boolean }>({
    message: undefined,
    encrypted: false,
  });

  // ── Workstream 6: shared error recovery for the standard payment path ──
  const handleDonationError = async (err: unknown) => {
    const fallbackError =
      err instanceof Error ? err.message : "An error occurred";

    // A wallet rejection is a cancel, not a failure: nothing was sent, so
    // return to a clean form with a dismissible notice instead of an error.
    if (
      /declined|rejected|cancelled|denied|user closed|popup closed/i.test(
        fallbackError,
      )
    ) {
      setStep("idle");
      setCancelNotice(
        "Signature cancelled — nothing was sent from your wallet. You can try again whenever you're ready.",
      );
      window.setTimeout(() => setCancelNotice(null), 8000);
      return;
    }

    if (!navigator.onLine) {
      await queueDonation({
        projectId: project.id,
        donorAddress: publicKey,
        amount: amountNum.toString(),
        currency,
        message:
          (pendingMessageRef.current.message ?? message.trim()) || undefined,
        encrypted: pendingMessageRef.current.encrypted,
        // Reuse the flow's idempotency key — never regenerate it: if the
        // original request actually reached the server before the connection
        // dropped, a retry with the SAME key is recognised as a duplicate and
        // never double-recorded.  (The key is always set before any attempt;
        // the fallback is only a type-level guard.)
        idempotencyKey: pendingIdempotencyRef.current ?? undefined,
      });
      // Queued ≠ success: keep the form usable and surface the outcome as a
      // dismissible notice instead of a dead confirmation card.
      setCancelNotice(
        "The donation could not be submitted right now, so it was queued for automatic retry.",
      );
      setStep("idle");
      return;
    }

    setError(fallbackError);
    setStep("error");
    setTimeout(() => setStep("idle"), 3000);
  };

  /**
   * Sign → submit → record for the standard XLM/USDC payment path.
   *
   * In V2 mode, a submission that drops before returning a result is not
   * reported as a failure: we poll Horizon for up to 60s and only fall back
   * to the honest "unknown" state (with an explorer link, persisted across
   * reloads) if the transaction never appears.
   */
  const submitStandardPayment = async (
    tx: Transaction,
    idempotencyKey: string,
  ) => {
    // Transaction.hash() returns a Buffer — hex-encode it so the recovery
    // path polls and persists the required 64-character hexadecimal hash.
    // Named expectedTxHash because it is the hash we EXPECT the signed tx to
    // produce (a rebuilt tx with identical params yields the same hash); the
    // txHash state below stores the hash actually submitted/confirmed.
    const expectedTxHash = tx.hash().toString("hex");

    setStep("signing");
    const { signedXDR, error: signErr } = await signTransactionWithWallet(
      tx.toXDR(),
    );
    if (signErr || !signedXDR) throw new Error(signErr || "Signing failed");

    trackEvent("donation_signed", {
      projectId: project.id,
      amountXLM: currency === "XLM" ? amountNum.toString() : undefined,
    });

    setStep("submitting");
    let result: { hash: string } | undefined;
    try {
      result = await submitTransaction(signedXDR);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const looksLikeNetworkDrop =
        /timeout|timed out|etimedout|econnreset|fetch failed|network error|socket hang up/i.test(
          msg,
        );

      if (ENABLE_DONATION_V2 && looksLikeNetworkDrop) {
        setStep("polling");
        try {
          await pollTransaction(expectedTxHash);
          setTxHash(expectedTxHash);
        } catch (pollErr: unknown) {
          // TRANSACTION_FAILED: the tx was included but failed on-chain.
          // TIMEOUT: the tx was never found in the polling window.  Both are
          // honest "unknown/check the explorer" outcomes — never a false
          // success, and never a fake error claiming nothing was sent.
          setTxHash(expectedTxHash);
          try {
            window.sessionStorage.setItem(
              "indigopay-unknown-tx",
              expectedTxHash,
            );
          } catch {
            // sessionStorage unavailable — unknown state still shown this visit.
          }
          setStep("unknown");
          return;
        }
      } else {
        throw err;
      }
    }

    setTxHash(result?.hash ?? expectedTxHash);
    setStep("recording");
    // Record exactly once via the React Query mutation (it performs the POST
    // and revalidates the donation feed).  A backend rejection (e.g. a
    // duplicate idempotency key from an earlier retry) must never surface as
    // an error after the on-chain payment already succeeded — the chain is
    // the source of truth.
    let donationStillProcessing = false;
    await recordDonationMutation.mutateAsync({
      projectId: project.id,
      donorAddress: publicKey,
      amount: amountNum.toString(),
      currency: currency,
      message: (pendingMessageRef.current.message ?? message.trim()) || undefined,
      encrypted: pendingMessageRef.current.encrypted,
      transactionHash: result?.hash ?? expectedTxHash,
      idempotencyKey,
    }).catch((error: unknown) => {
      // Backend recording failure — the donation is already on-chain.
      donationStillProcessing = isDonationProcessingError(error);
    });
    if (donationStillProcessing) {
      setStep("unknown");
      return;
    }

    trackEvent("donation_confirmed", {
      projectId: project.id,
      amountXLM: currency === "XLM" ? amountNum.toString() : undefined,
    });

    refreshBalances();
    setStep("success");
    onSuccess?.();
  };

  /**
   * V2 preview confirmation — the donor reviewed the simulation and clicked
   * "Confirm & Sign".  Rebuilds the transaction fresh (same params, fresh
   * sequence + 60s time bound) so the signed transaction is never stale, then
   * signs and submits.
   */
  const handleConfirmSign = async () => {
    if (step !== "preview" || !pendingParamsRef.current) return;
    setError(null);
    try {
      const freshTx = await buildDonationTransaction(pendingParamsRef.current);
      const idempotencyKey = pendingIdempotencyRef.current;
      if (!idempotencyKey) throw new Error("Missing donation idempotency key");
      await submitStandardPayment(freshTx, idempotencyKey);
    } catch (err: unknown) {
      await handleDonationError(err);
    }
  };

  const handleDonate = async () => {
    const isOk = validate({
      amount,
      message: message || undefined,
      projectId: project.id,
    });
    if (!isOk || step !== "idle") return;
    setError(null);

    // Generate a unique idempotency key so the backend can safely deduplicate
    // retried donation-recording requests within 24 hours.
    const idempotencyKey = safeRandomUUID();
    pendingIdempotencyRef.current = idempotencyKey;

    // Private messages are encrypted with the project's public key before
    // they leave the browser; the outcome is kept for every downstream step
    // (preview confirm, offline queue, record) so the payload is stable.
    let finalMessage = message.trim();
    let isEncrypted = false;
    if (finalMessage && isPrivateMessage) {
      finalMessage = encryptMessage(finalMessage, project.walletAddress);
      isEncrypted = true;
    }
    pendingMessageRef.current = {
      message: finalMessage || undefined,
      encrypted: isEncrypted,
    };

    if (!isOnline) {
      await queueDonation({
        projectId: project.id,
        donorAddress: publicKey,
        amount: amountNum.toString(),
        currency,
        message: finalMessage || undefined,
        encrypted: isEncrypted,
        idempotencyKey,
      });
      // Queued ≠ success: keep the form usable and surface the outcome as a
      // dismissible notice instead of a dead confirmation card.
      setCancelNotice(
        "Your donation was queued while offline. It will be sent automatically once you reconnect.",
      );
      setStep("idle");
      return;
    }

    trackEvent("donation_initiated", {
      projectId: project.id,
      currency: selectedAsset ? selectedAsset.code : currency,
      amountXLM: selectedAsset
        ? conversionEstimate?.estimatedXLM
        : currency === "XLM"
          ? amount
          : undefined,
    });

    try {
      if (isRecurring) {
        if (!CONTRACT_ID) {
          throw new Error("Recurring donations require the smart contract to be configured.");
        }

        setStep("building");
        const nativeTokenAddress =
          "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"; // Native XLM on testnet

        const passphrase =
          process.env.NEXT_PUBLIC_STELLAR_NETWORK === "mainnet"
            ? "Public Global Stellar Network ; October 2015"
            : "Test SDF Network ; September 2015";

        const tokenAddress =
          currency === "XLM"
            ? nativeTokenAddress
            : new Asset("USDC", process.env.NEXT_PUBLIC_USDC_ISSUER!).contractId(passphrase);

        // 1. Approve allowance: (amount + 0.5 keeper incentive) * 12
        const totalPerExecution = amountNum + 0.5;
        const allowanceAmount = (totalPerExecution * 12).toFixed(7);

        setStep("building");
        const approveTx = await buildApproveTransaction({
          tokenAddress,
          user: publicKey,
          spender: CONTRACT_ID,
          amount: allowanceAmount,
        });

        setStep("signing");
        const { signedXDR: approveSigned, error: approveSignErr } =
          await signTransactionWithWallet(approveTx.toXDR());
        if (approveSignErr || !approveSigned) {
          throw new Error(approveSignErr || "Token approval signature failed");
        }

        setStep("submitting");
        await submitTransaction(approveSigned);

        // 2. Create recurring donation
        setStep("building");
        const msgHash = message.trim() ? hashMessage(message.trim()) : 0;
        const intervalLedgers = FREQUENCY_LEDGERS[frequency] || 518400;

        const createTx = await buildCreateRecurringTransaction({
          contractId: CONTRACT_ID,
          donor: publicKey,
          projectId: project.id,
          amount: amountNum.toFixed(7),
          currency,
          intervalLedgers,
          keeperIncentive: "0.5000000",
          msgHash,
        });

        setStep("signing");
        const { signedXDR: createSigned, error: createSignErr } =
          await signTransactionWithWallet(createTx.toXDR());
        if (createSignErr || !createSigned) {
          throw new Error(createSignErr || "Creation transaction signature failed");
        }

        setStep("submitting");
        const result = await submitTransaction(createSigned);
        setTxHash(result.hash);

        refreshBalances();
        setStep("success");
        onSuccess?.();
        return;
      }

      const useContract = CONTRACT_ID && currency === "XLM";

      if (useContract) {
        setStep("building");

        // Get native XLM token address (for testnet/mainnet)
        const nativeTokenAddress =
          "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC"; // Native XLM on testnet
        const msgHash = message.trim() ? hashMessage(message.trim()) : 0;

        const tx = await buildContractDonationTransaction({
          contractId: CONTRACT_ID,
          tokenAddress: nativeTokenAddress,
          donor: publicKey,
          projectId: project.id,
          amount: amountNum.toFixed(7),
          msgHash,
        });

        setStep("signing");
        const { signedXDR, error: signErr } = await signTransactionWithWallet(
          tx.toXDR(),
        );
        if (signErr || !signedXDR) throw new Error(signErr || "Signing failed");

        trackEvent("donation_signed", {
          projectId: project.id,
          amountXLM: amountNum.toString(),
        });

        setStep("submitting");
        const result = await submitTransaction(signedXDR);
        setTxHash(result.hash);

        setStep("recording");
        // Query updated donor stats from contract
        const stats = await getDonorStats(publicKey);
        if (stats && stats.badge) {
          const badgeNames: Record<string, string> = {
            Seedling: "🌱 Seedling",
            Tree: "🌳 Tree",
            Forest: "🌲 Forest",
            EarthGuardian: "🌍 Earth Guardian",
          };
          setDonorBadge(badgeNames[stats.badge] || null);
        }

        // Still record in backend for feed/analytics. Match the standard
        // path: a 202 means the on-chain payment may already be recorded, so
        // do not present a completed donation that could be submitted again.
        let donationStillProcessing = false;
        await recordDonationMutation.mutateAsync({
          projectId: project.id,
          donorAddress: publicKey,
          amount: amountNum.toString(),
          currency: currency,
          message: finalMessage || undefined,
          encrypted: isEncrypted,
          transactionHash: result.hash,
          idempotencyKey,
        }).catch((error: unknown) => {
          donationStillProcessing = isDonationProcessingError(error);
        });
        if (donationStillProcessing) {
          setStep("unknown");
          return;
        }

        trackEvent("donation_confirmed", {
          projectId: project.id,
          amountXLM: amountNum.toString(),
        });

        refreshBalances();
        setStep("success");
        onSuccess?.();
        return;
      }

      // ── Standard Payment (XLM or USDC) ──────────────────────────────
      setStep("building");
      const asset =
        currency === "USDC"
          ? { code: "USDC", issuer: process.env.NEXT_PUBLIC_USDC_ISSUER }
          : undefined;

      if (currency === "USDC") {
        if (!process.env.NEXT_PUBLIC_USDC_ISSUER)
          throw new Error(
            "USDC issuer not configured (NEXT_PUBLIC_USDC_ISSUER).",
          );
        if (trustlineMissing)
          throw new Error(
            "No USDC trustline on your account. Add a trustline to receive/send USDC.",
          );
      }

      const paymentParams = {
        fromPublicKey: publicKey,
        toPublicKey: project.walletAddress,
        amount:
          currency === "XLM" ? amountNum.toFixed(7) : amountNum.toFixed(2),
        memo: `IndigoPay:${project.id.slice(0, 16)}`,
        asset,
      };
      // Workstream 5 (V2): show the simulation preview before the wallet
      // prompt — no blind signing.  The params are kept so the transaction is
      // rebuilt fresh at confirm time (stale-tx safety), never re-signed.
      // simulateDonation builds its own transaction, so on the V2 path we
      // skip building here — one Horizon account load instead of two.
      if (ENABLE_DONATION_V2) {
        pendingParamsRef.current = paymentParams;
        const sim = await simulateDonation({
          fromPublicKey: publicKey,
          toPublicKey: project.walletAddress,
          amount:
            currency === "XLM" ? amountNum.toFixed(7) : amountNum.toFixed(2),
          currency,
          memo: `IndigoPay:${project.id.slice(0, 16)}`,
          asset,
        });
        setSimulation(sim);
        setStep("preview");
        return;
      }

      // Legacy flow: straight to sign + submit.
      const tx = await buildDonationTransaction(paymentParams);
      await submitStandardPayment(tx, idempotencyKey);
    } catch (err: unknown) {
      await handleDonationError(err);
    }
  };

  if (step === "success" && txHash) {
    return (
      <div className="card text-center animate-slide-up" data-testid="donation-success">
        {/* Workstream 6/7: assertively announce the confirmation. */}
        <p className="sr-only" aria-live="assertive" data-testid="success-live-region">
          Donation confirmed.{" "}
          {currency === "XLM"
            ? formatXLM(amountNum)
            : `${amountNum.toFixed(2)} ${currency}`}{" "}
          sent to {project.name}.
        </p>
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center text-2xl mx-auto mb-4 shadow-lg">
          🌱
        </div>
        <h3
          ref={resultHeadingRef}
          tabIndex={-1}
          className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4F46E5] dark:focus-visible:outline-[#818CF8] rounded"
        >
          Thank you!
        </h3>
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-4 font-body">
          Your donation of{" "}
          <span className="font-semibold text-[#4F46E5] dark:text-[#818CF8]">
            {currency === "XLM"
              ? formatXLM(amountNum)
              : `${amountNum.toFixed(2)} ${currency}`}
          </span>{" "}
          has been sent to <span className="font-semibold">{project.name}</span>
          .
        </p>

        {/* Updated balance after donation */}
        {xlmBalance !== null && (
          <div className="mb-4 p-3 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] rounded-xl">
            <p className="text-xs text-[#475569] dark:text-[#94A3B8] font-body">
              Updated Balance
            </p>
            <p className="text-lg font-display font-bold text-[#0F172A] dark:text-[#E2E8F0]">
              {formatXLM(parseFloat(xlmBalance))} XLM
            </p>
          </div>
        )}

        {donorBadge && (
          <div className="mb-4 p-4 bg-[rgba(99,102,241,0.06)] border border-[rgba(99,102,241,0.12)] rounded-xl">
            <p className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-1">
              🎉 Congrats! You earned a new badge!
            </p>
            <p className="text-lg font-bold text-gradient">{donorBadge}</p>
          </div>
        )}
        <a
          href={explorerUrl(txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-[#4F46E5] dark:text-[#818CF8] hover:text-[#6366F1] transition-colors font-body font-medium"
        >
          View on Stellar Expert ↗
        </a>
      </div>
    );
  }
  // Workstream 5 (V2): the review step — render the preview instead of the
  // form so the donor confirms the exact transaction before any wallet prompt.
  // The preview stays mounted (in busy state) while signing/submitting so the
  // donor always sees what they approved.
  if (
    simulation &&
    ENABLE_DONATION_V2 &&
    (["preview", "signing", "submitting", "polling"] as Step[]).includes(step)
  ) {
    return (
      <div
        className="card animate-fade-in"
        aria-busy={step !== "preview"}
        data-testid="donate-form"
      >
        <h3
          ref={previewHeadingRef}
          tabIndex={-1}
          className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-1 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4F46E5] dark:focus-visible:outline-[#818CF8] rounded"
        >
          Confirm your donation
        </h3>
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-5 font-body">
          Review the details below before approving in your wallet.
        </p>
        <TransactionPreview
          simulation={simulation}
          projectName={project.name}
          onConfirm={handleConfirmSign}
          onBack={() => {
            pendingParamsRef.current = null;
            pendingIdempotencyRef.current = null;
            pendingMessageRef.current = {
              message: undefined,
              encrypted: false,
            };
            setSimulation(null);
            setStep("idle");
          }}
          busy={step !== "preview"}
        />
      </div>
    );
  }

  // Workstream 6: the honest "unknown" state — the transaction was submitted
  // but we never learned its outcome.  Never claim failure; link the explorer.
  // (A queued donation is NOT a success-with-null-hash anymore: both offline
  // queue paths keep the form on the idle step with a dismissible notice, so
  // the success branch below always carries a real tx hash.)
  if (step === "unknown" && txHash) {
    return (
      <div
        className="card text-center animate-slide-up"
        data-testid="donation-unknown"
      >
        {/* Workstream 6/7: assertively announce the honest unknown outcome. */}
        <p className="sr-only" aria-live="assertive" data-testid="unknown-live-region">
          Transaction status unknown. Check the explorer link for details.
        </p>
        <div className="w-16 h-16 rounded-2xl bg-amber-100 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 flex items-center justify-center text-2xl mx-auto mb-4">
          ⏳
        </div>
        <h3
          ref={resultHeadingRef}
          tabIndex={-1}
          className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4F46E5] dark:focus-visible:outline-[#818CF8] rounded"
        >
          We couldn&apos;t confirm your transaction
        </h3>
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-2 font-body leading-relaxed">
          Your donation request was submitted, but the connection dropped before
          we could confirm it. It may still complete — check your wallet or the
          Stellar explorer for its status.
        </p>
        <p className="text-xs text-[#475569] dark:text-[#94A3B8] font-body mb-4">
          Your funds were not lost. If you see the transaction on the explorer,
          no action is needed.
        </p>
        <a
          href={explorerUrl(txHash)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-sm text-[#4F46E5] dark:text-[#818CF8] hover:text-[#6366F1] transition-colors font-body font-medium mb-4"
          data-testid="unknown-explorer-link"
        >
          Check transaction on Stellar Expert ↗
        </a>
        <div>
          <button
            onClick={() => {
              try {
                window.sessionStorage.removeItem("indigopay-unknown-tx");
              } catch {
                // ignore
              }
              setTxHash(null);
              setStep("idle");
            }}
            className="text-sm text-[#475569] dark:text-[#94A3B8] underline hover:text-[#0F172A] dark:hover:text-[#E2E8F0] font-body"
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card animate-fade-in" aria-busy={step !== "idle"} data-testid="donate-form">
      {/* Hidden live region describing the current donation flow status so
          screen-reader users hear each step change without visual cues. */}
      <p className="sr-only" aria-live="polite">
        {step === "building" && "Building donation transaction…"}
        {step === "signing" && "Awaiting wallet signature."}
        {step === "submitting" && "Submitting transaction to Stellar."}
        {step === "polling" && "Checking whether the transaction was included on-chain."}
        {step === "recording" && "Recording donation. Almost done."}
        {step === "unknown" && "The transaction was submitted but its status is unknown. See the explorer link."}
      </p>
      {/* Hidden live region that assertively announces validation errors
          (e.g. invalid amount, message too long) when the user clicks
          "Donate" with invalid input. Purely for assistive tech; produces
          no visual output. */}
      <div
        aria-live="assertive"
        className="sr-only"
        data-testid="validation-live-region"
      >
        {validationAnnouncement}
      </div>
      <h3 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-1">
        Make a Donation
      </h3>
      <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-5 font-body">
        100% goes directly to the project wallet.
      </p>

      {/* Workstream 6: wallet-cancel notice — dismissible, not an error. */}
      {cancelNotice && (
        <div
          className="mb-4 p-3 rounded-xl bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-sm text-[#0F172A] dark:text-[#E2E8F0] font-body flex items-start justify-between gap-3"
          role="status"
          data-testid="cancel-notice"
        >
          <span>{cancelNotice}</span>
          <button
            type="button"
            onClick={() => setCancelNotice(null)}
            aria-label="Dismiss notice"
            className="shrink-0 text-[#475569] dark:text-[#94A3B8] hover:text-[#0F172A] dark:hover:text-[#E2E8F0] transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      <div className="space-y-4">
        {/* Currency selector */}
        <div>
          <label className="label">Currency</label>
          <div className="flex gap-2">
            <button
              onClick={() => setCurrency("XLM")}
              className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all font-body ${currency === "XLM" ? "btn-primary text-white border-0" : "bg-white dark:bg-[#14142D] border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[#475569] dark:text-[#94A3B8]"}`}
            >
              XLM
            </button>
            <button
              onClick={() => setCurrency("USDC")}
              className={`px-3 py-2 rounded-xl text-sm font-medium border transition-all font-body ${currency === "USDC" ? "btn-primary text-white border-0" : "bg-white dark:bg-[#14142D] border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[#475569] dark:text-[#94A3B8]"}`}
            >
              USDC
            </button>
          </div>
        </div>
        {/* Preset amounts */}
        <div>
          <span className="label block mb-2">Choose Amount ({selectedAsset ? selectedAsset.code : currency})</span>
          <div className="flex flex-wrap gap-2 mb-3">
            {(currency === "XLM" ? PRESETS_XLM : PRESETS_USDC).map((p) => (
              <button
                key={p}
                onClick={() => {
                  setAmount(p);
                  clearField("amount");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setAmount(p);
                    clearField("amount");
                  }
                }}
                className={`px-4 py-2 rounded-xl text-sm font-medium border transition-all font-body ${
                  amount === p
                    ? "btn-primary text-white border-0"
                    : "bg-[rgba(99,102,241,0.06)] dark:bg-[rgba(129,140,248,0.08)] text-[#4F46E5] dark:text-[#818CF8] border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] hover:border-[rgba(99,102,241,0.30)]"
                }`}
              >
                {p} {currency}
              </button>
            ))}
          </div>
          <div className="flex items-start gap-2">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="Or enter custom amount..."
              min="1"
              step="1"
              className="input-field flex-1"
              data-testid="donation-amount"
              aria-invalid={Boolean(amount) && (!isValid || Boolean(balanceErrorMessage))}
              aria-describedby={
                amount && (!isValid || balanceErrorMessage)
                  ? [
                      !isValid ? "donate-amount-error" : null,
                      balanceErrorMessage ? "donate-balance-error" : null,
                    ]
                      .filter(Boolean)
                      .join(" ")
                  : undefined
              }
              inputMode="decimal"
            />
            {/* Workstream 1: Max button — balance − reserve − fee − 1 stroop. */}
            {currency === "XLM" && balanceNum !== null && (
              <button
                type="button"
                onClick={() => {
                  setAmount(maxDonationXLM);
                  clearField("amount");
                }}
                disabled={maxDonationNum <= 0}
                className="shrink-0 px-3 py-2 rounded-xl text-sm font-semibold font-body border transition-all border-[rgba(99,102,241,0.25)] dark:border-[rgba(129,140,248,0.30)] text-[#4F46E5] dark:text-[#818CF8] hover:bg-[rgba(99,102,241,0.06)] dark:hover:bg-[rgba(129,140,248,0.08)] disabled:opacity-40 disabled:cursor-not-allowed"
                data-testid="max-button"
                title={`Max: ${formatXLM(maxDonationNum)} (keeps the ${reserveXLM.toFixed(2)} XLM reserve and network fee)`}
              >
                Max
              </button>
            )}
          </div>
          {amount && !isValid && (
            <p
              id="donate-amount-error"
              className="mt-1 text-xs text-[#B91C1C] dark:text-[#FCA5A5]"
              role="alert"
            >
              Minimum donation is 1 {currency}
            </p>
          )}
          {balanceErrorMessage && (
            <p
              id="donate-balance-error"
              className="mt-1 text-xs text-[#B91C1C] dark:text-[#FCA5A5]"
              role="alert"
              data-testid="insufficient-balance-error"
            >
              {balanceErrorMessage}
            </p>
          )}
          {currency === "XLM" && balanceNum !== null && (
            <p
              className="mt-1 text-xs text-[#475569] dark:text-[#94A3B8] font-body"
              data-testid="fee-estimate"
            >
              Estimated network fee: {formatFeeXLM(feeStroops)} (
              {feeStroops.toLocaleString()} stroops)
              {xlmUsd !== null && !isDegraded && (
                <>
                  {" "}·{" "}
                  {formatUSDEquivalent(
                    parseFloat(stroopsToXLM(feeStroops)),
                    xlmUsd,
                  )}
                </>
              )}{" "}
              · Balance: {formatXLM(balanceNum)}
            </p>
          )}

          {/* USD equivalent with staleness indicator */}
          {currency === "XLM" && amount && !isNaN(amountNum) && amountNum > 0 && (
            <p
              className="mt-2 text-xs text-[#475569] dark:text-[#94A3B8] font-body flex items-center gap-1"
              data-testid="usd-equivalent"
              data-price-stale={isStale || isDegraded ? "true" : undefined}
            >
              {isDegraded ? (
                <>
                  <span>≈</span>
                  <span className="text-orange-500 dark:text-orange-400" aria-label="USD equivalent unavailable">—</span>
                  <PriceStaleIndicator isStale={isStale} isDegraded={isDegraded} priceAgeMs={priceAgeMs} />
                </>
              ) : xlmUsd !== null ? (
                <>
                  <span>{formatUSDEquivalent(amountNum, xlmUsd)}</span>
                  <PriceStaleIndicator isStale={isStale} isDegraded={isDegraded} priceAgeMs={priceAgeMs} />
                </>
              ) : null}
            </p>
          )}

          {/* CO₂ Impact Calculator */}
          {currency === "XLM" &&
            amount &&
            !isNaN(amountNum) &&
            co2Impact > 0 && (
              <div className="mt-3 p-4 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] rounded-xl">
                <p className="text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0] mb-1">
                  🌱 Your donation will offset approximately{" "}
                  <span className="font-bold text-[#4F46E5] dark:text-[#818CF8]">
                    {formatCO2(co2Impact)}
                  </span>
                </p>
                {treeEquivalent > 0 && (
                  <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-1">
                    That is equivalent to planting about{" "}
                    <span className="font-semibold">
                      {treeEquivalent} {treeEquivalent === 1 ? "tree" : "trees"}
                    </span>
                  </p>
                )}
              </div>
            )}
        </div>

        {/* Message */}
        <div>
          <FormField
            name="message"
            label="Message (optional)"
            error={errors.message}
            helper="Your message will appear in the public donation feed"
          >
            <input
              type="text"
              value={message}
              onChange={(e) => {
                setMessage(e.target.value);
                clearField("message");
              }}
              placeholder="Leave a message of support..."
              maxLength={100}
              className="input-field"
            />
          </FormField>

          {/* Private message (from main): encrypt the message with the
              project's public key so it cannot be read on-chain. */}
          <label className="flex items-center gap-2 mt-2 cursor-pointer">
            <input
              type="checkbox"
              checked={isPrivateMessage}
              onChange={(e) => setIsPrivateMessage(e.target.checked)}
              className="w-4 h-4 rounded text-[#4F46E5] focus:ring-[#4F46E5] border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800"
            />
            <span className="text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0]">
              Private message
            </span>
          </label>
        </div>



        {/* Character counter */}
        <p className={`text-xs mt-1 ${getCounterColor()}`}>
          {charCount} / 100 characters
        </p>

        {/* Recurring Donation Checkbox */}
        {CONTRACT_ID && (
          <div className="p-4 bg-[rgba(99,102,241,0.04)] dark:bg-[rgba(129,140,248,0.06)] border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)] rounded-xl space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isRecurring}
                onChange={(e) => setIsRecurring(e.target.checked)}
                className="w-4 h-4 rounded text-[#4F46E5] focus:ring-[#4F46E5] border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800"
              />
              <span className="text-sm font-medium text-[#0F172A] dark:text-[#E2E8F0]">
                Make this a recurring donation
              </span>
            </label>

            {isRecurring && (
              <div className="space-y-2 animate-fade-in pl-6 font-body">
                <span className="label block text-xs font-semibold text-gray-500 uppercase tracking-wider mb-1">Frequency</span>
                <div className="flex gap-2">
                  {(["weekly", "monthly", "quarterly"] as const).map((freq) => (
                    <button
                      key={freq}
                      type="button"
                      onClick={() => setFrequency(freq)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold capitalize border transition-all ${
                        frequency === freq
                          ? "btn-primary text-white border-0"
                          : "bg-white dark:bg-[#14142D] border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] text-[#475569] dark:text-[#94A3B8]"
                      }`}
                    >
                      {freq}
                    </button>
                  ))}
                </div>
                <p className="text-xs text-[#475569] dark:text-[#94A3B8] mt-2">
                  Requires a one-time wallet approval signature for the total 1-year allowance, enabling trustless scheduling. A small keeper incentive (0.50 {currency}) is added per transaction to reward keepers.
                </p>
              </div>
            )}
          </div>
        )}
      </div>

      {step === "error" && error && (
        <div
          className="p-3 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm font-body"
          role="alert"
        >
          {error}
        </div>
      )}

      {currency === "USDC" && (
        <div className="text-xs text-muted-foreground">
          <p>Balances:</p>
          <p>
            XLM: <span className="font-medium">{xlmBalance ?? "—"}</span>
          </p>
          <p>
            USDC:{" "}
            <span className="font-medium">
              {usdcBalance === null ? "No trustline" : usdcBalance}
            </span>
          </p>
          {usdcBalance === null && (
            <div className="mt-2 text-sm text-amber-600">
              You don&apos;t have a USDC trustline on this account. Add a
              trustline in your wallet or follow these instructions to accept
              USDC:{" "}
              <a
                href="https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/assets/"
                target="_blank"
                rel="noopener noreferrer"
                className="underline"
              >
                Add trustline
              </a>
            </div>
          )}
        </div>
      )}

      <button
        onClick={handleDonate}
        disabled={!canSubmit}
        className="btn-primary w-full flex items-center justify-center gap-2"
        data-testid="donate-button"
      >
        {step === "building" && (
          <>
            <Spinner />
            Building transaction...
          </>
        )}
        {step === "signing" && (
          <>
            <Spinner />
            Sign in wallet...
          </>
        )}
        {step === "submitting" && (
          <>
            <Spinner />
            Submitting...
          </>
        )}
        {step === "polling" && (
          <>
            <Spinner />
            Confirming on-chain...
          </>
        )}
        {step === "recording" && <>Done</>}
        {step === "idle" && (
          <>
            🌱 Donate{" "}
            {amount
              ? currency === "XLM"
                ? formatXLM(amountNum)
                : `$${amountNum.toFixed(2)} ${currency}`
              : currency}
          </>
        )}
        {step === "error" && "Retry"}
      </button>

      {step === "signing" && (
        <p className="text-center text-xs text-[#475569] dark:text-[#94A3B8] animate-pulse font-body" aria-live="polite">
          Please confirm in your Freighter wallet...
        </p>
      )}
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24" fill="none">
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}
