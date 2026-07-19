/**
 * components/DonateForm.tsx
 * Donation form for a climate project.
 */
import FormField from "@/components/FormField";
import { useFormValidation } from "@/hooks/useFormValidation";
import { donationSchema } from "@/lib/validation/schemas";
import { useState, useEffect } from "react";
import {
  buildDonationTransaction,
  buildContractDonationTransaction,
  submitTransaction,
  explorerUrl,
  getXLMBalance,
  getAssetBalance,
  getDonorStats,
  hashMessage,
  CONTRACT_ID,
} from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";
import { recordDonation } from "@/lib/api";
import useOnlineStatus from "@/hooks/useOnlineStatus";
import { queueDonation, syncQueuedDonations } from "@/lib/offlineDonationQueue";
import { formatXLM, formatCO2 } from "@/utils/format";
import { safeRandomUUID } from "@/utils/uuid";
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
  | "signing"
  | "submitting"
  | "recording"
  | "success"
  | "error";

const PRESETS_XLM = ["10", "25", "50", "100", "250"];
const PRESETS_USDC = ["5", "10", "25", "50", "100"];

export default function DonateForm({
  project,
  publicKey,
  initialAmount,
  initialMessage,
  onSuccess,
}: DonateFormProps) {
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [currency, setCurrency] = useState<"XLM" | "USDC">("XLM");
  const [step, setStep] = useState<Step>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [xlmBalance, setXlmBalance] = useState<string | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<string | null>(null);
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

  useEffect(() => {
    if (!initialAmount) return;
    setAmount(initialAmount);
  }, [initialAmount]);

  useEffect(() => {
    if (!initialMessage) return;
    setMessage(initialMessage);
  }, [initialMessage]);

  useEffect(() => {
    let mounted = true;
    async function loadBalances() {
      if (!publicKey) return;
      try {
        const xlm = await getXLMBalance(publicKey);
        if (!mounted) return;
        setXlmBalance(xlm);
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
    return () => {
      mounted = false;
    };
  }, [publicKey, currency]);

  const { errors, validate, clearField } = useFormValidation(donationSchema);

  const amountNum = parseFloat(amount);
  const isValid = donationSchema.safeParse({
    amount,
    message: message || undefined,
    projectId: project.id,
  }).success;

  // Calculate CO₂ impact for XLM donations
  const co2Impact =
    currency === "XLM" && amount && !isNaN(amountNum) && project.co2_per_xlm
      ? (amountNum * project.co2_per_xlm) / 1000 // Convert to kg
      : 0;

  // Calculate tree equivalent (rough estimate: 1 tree absorbs ~22kg CO₂ per year)
  const treeEquivalent = co2Impact > 0 ? Math.round(co2Impact / 22) : 0;

  const charCount = message.length;

  const getCounterColor = () => {
    if (charCount >= 96) return "text-red-500";
    if (charCount >= 80) return "text-amber-500";
    return "text-[#4F46E5]";
  };

  useEffect(() => {
    if (!isOnline) return;

    void syncQueuedDonations(async (payload) => {
      try {
        await recordDonation({
          ...payload,
          transactionHash: payload.transactionHash || "queued-offline",
        });
        return true;
      } catch {
        return false;
      }
    });
  }, [isOnline]);

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

    if (!isOnline) {
      await queueDonation({
        projectId: project.id,
        donorAddress: publicKey,
        amount: amountNum.toString(),
        currency,
        message: message.trim() || undefined,
        idempotencyKey,
      });
      setStep("success");
      setTxHash(null);
      setError(
        "Your donation was queued while offline. It will be sent automatically once you reconnect.",
      );
      return;
    }

    try {
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

        // Still record in backend for feed/analytics
        await recordDonation({
          projectId: project.id,
          donorAddress: publicKey,
          amount: amountNum.toString(),
          currency: currency,
          message: message.trim() || undefined,
          transactionHash: result.hash,
          idempotencyKey,
        });

        setStep("success");
        onSuccess?.();
      } else {
        // Fallback to standard payment
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

        const tx = await buildDonationTransaction({
          fromPublicKey: publicKey,
          toPublicKey: project.walletAddress,
          amount:
            currency === "XLM" ? amountNum.toFixed(7) : amountNum.toFixed(2),
          memo: `IndigoPay:${project.id.slice(0, 16)}`,
          asset,
        });

        setStep("signing");
        const { signedXDR, error: signErr } = await signTransactionWithWallet(
          tx.toXDR(),
        );
        if (signErr || !signedXDR) throw new Error(signErr || "Signing failed");

        setStep("submitting");
        const result = await submitTransaction(signedXDR);
        setTxHash(result.hash);

        setStep("recording");
        await recordDonation({
          projectId: project.id,
          donorAddress: publicKey,
          amount: amountNum.toString(),
          currency: currency,
          message: message.trim() || undefined,
          transactionHash: result.hash,
          idempotencyKey,
        });

        setStep("success");
        onSuccess?.();
      }
    } catch (err: unknown) {
      const fallbackError =
        err instanceof Error ? err.message : "An error occurred";
      if (!navigator.onLine) {
        await queueDonation({
          projectId: project.id,
          donorAddress: publicKey,
          amount: amountNum.toString(),
          currency,
          message: message.trim() || undefined,
          idempotencyKey,
        });
        setError("The donation could not be submitted right now, so it was queued for automatic retry.");
        setStep("success");
        setTxHash(null);
        return;
      }
      setError(fallbackError);
      setStep("error");
      setTimeout(() => setStep("idle"), 3000);
    }
  };

  if (step === "success" && txHash) {
    return (
      <div className="card text-center animate-slide-up" data-testid="donation-success">
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center text-2xl mx-auto mb-4 shadow-lg">
          🌱
        </div>
        <h3 className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
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
  return (
    <div className="card animate-fade-in" aria-busy={step !== "idle"}>
      {/* Hidden live region describing the current donation flow status so
          screen-reader users hear each step change without visual cues. */}
      <p className="sr-only" aria-live="polite">
        {step === "building" && "Building donation transaction…"}
        {step === "signing" && "Awaiting wallet signature."}
        {step === "submitting" && "Submitting transaction to Stellar."}
        {step === "recording" && "Recording donation. Almost done."}
      </p>
      <h3 className="font-display text-lg font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-1">
        Make a Donation
      </h3>
      <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-5 font-body">
        100% goes directly to the project wallet.
      </p>

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
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Or enter custom amount..."
            min="1"
            step="1"
            className="input-field"
            data-testid="donation-amount"
            aria-invalid={Boolean(amount) && !isValid}
            aria-describedby={amount && !isValid ? "donate-amount-error" : undefined}
            inputMode="decimal"
          />
          {amount && !isValid && (
            <p
              id="donate-amount-error"
              className="mt-1 text-xs text-[#B91C1C] dark:text-[#FCA5A5]"
              role="alert"
            >
              Minimum donation is 1 {currency}
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
        </div>



        {/* Character counter */}
        <p className={`text-xs mt-1 ${getCounterColor()}`}>
          {charCount} / 100 characters
        </p>
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
        disabled={!isValid || step !== "idle"}
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
            Sign in Freighter...
          </>
        )}
        {step === "submitting" && (
          <>
            <Spinner />
            Submitting...
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
