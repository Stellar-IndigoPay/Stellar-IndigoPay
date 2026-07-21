/**
 * components/WalletConnect.tsx
 * Wallet connection card with indigo theme.
 */
import { useState } from "react";
import { connectWallet, isFreighterInstalled } from "@/lib/wallet";
import { trackEvent } from "@/lib/analytics";
import { useI18n } from "@/lib/i18n";

interface WalletConnectProps {
  onConnect: (pk: string) => void;
}

export default function WalletConnect({ onConnect }: WalletConnectProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { t } = useI18n();

  const handleConnect = async () => {
    setLoading(true);
    setError(null);
    const installed = await isFreighterInstalled();
    if (!installed) {
      window.open("https://freighter.app", "_blank");
      setLoading(false);
      return;
    }
    const { publicKey, error: e } = await connectWallet();
    setLoading(false);
    if (e) {
      setError(e);
      return;
    }
    if (publicKey) {
      trackEvent("wallet_connected");
      onConnect(publicKey);
    }
  };

  return (
    <div className="card max-w-sm mx-auto text-center animate-slide-up shadow-indigo">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center mx-auto mb-5 shadow-lg shadow-[rgba(79,70,229,0.25)]">
        <svg
          className="w-8 h-8 text-white"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3"
          />
        </svg>
      </div>
      <h3 className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
        {t("wallet.connectTitle")}
      </h3>
      <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-5 font-body leading-relaxed">
        {t("wallet.connectDesc")}
      </p>
      {error && (
        <div className="mb-4 p-3 rounded-xl bg-[rgba(244,63,94,0.08)] border border-[rgba(244,63,94,0.15)] text-[#E11D48] dark:text-[#FB7185] text-sm font-body">
          {error}
        </div>
      )}
      <button
        onClick={handleConnect}
        disabled={loading}
        className="btn-primary w-full flex items-center justify-center gap-2"
        data-testid="wallet-connect-button"
      >
        {loading ? (
          <>
            <Spinner />
            {t("wallet.connecting")}
          </>
        ) : (
          t("wallet.connectBtn")
        )}
      </button>
      <p className="mt-3 text-xs text-[#64748B] dark:text-[#94A3B8] font-body">
        {t("wallet.noWallet")}{" "}
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium"
        >
          {t("wallet.installFreighter")}
        </a>
      </p>
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
