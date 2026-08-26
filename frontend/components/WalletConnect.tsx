/**
 * components/WalletConnect.tsx
 *
 * Wallet connection card with indigo theme. Shows a wallet picker
 * when multiple Stellar wallets are detected, or a single connect
 * button when only one is available.
 *
 * Supported wallets: Freighter, Albedo, xBull, Rabet, WalletConnect.
 */
import { useState, useEffect, useRef } from "react";
import { trackEvent } from "@/lib/analytics";
import { useI18n } from "@/lib/i18n";
import { getAvailableWallets, persistWalletSelection } from "@/lib/wallets";
import type { StellarWalletAdapter, WalletId } from "@/lib/wallets/types";

interface WalletConnectProps {
  /** Called after successful connection with the wallet's public key. */
  onConnect: (pk: string) => void;
}

/** Icon components mapped by wallet id for visual recognition. */
const WalletIcon: Record<string, () => JSX.Element> = {
  freighter: () => (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
    </svg>
  ),
  albedo: () => (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <circle cx="12" cy="12" r="9" />
      <path strokeLinecap="round" d="M12 3v18M3 12h18" />
    </svg>
  ),
  xbull: () => (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z" />
    </svg>
  ),
  walletConnect: () => (
    <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z" />
    </svg>
  ),
};

export default function WalletConnect({ onConnect }: WalletConnectProps) {
  const [loading, setLoading] = useState<string | null>(null); // wallet id being connected, or null
  const [error, setError] = useState<string | null>(null);
  const [availableWallets, setAvailableWallets] = useState<StellarWalletAdapter[]>([]);
  const [detected, setDetected] = useState(false);
  const { t } = useI18n();

  // Detect available wallets on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const wallets = await getAvailableWallets();
      if (cancelled) return;
      setAvailableWallets(wallets);
      setDetected(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Workstream 7, issue #1096 WS7 gap #3: the picker is intentionally INLINE
  // (not a modal), so a focus-trap is not required — WCAG requires focus
  // trapping only for <dialog> overlays.  We instead manage focus: when the
  // picker appears after detection, it receives focus so keyboard and
  // screen-reader users land directly on the wallet selection instead of
  // being stranded at the top of the page.
  const pickerHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (detected && availableWallets.length > 0) {
      // Defer so the transition animation completes before moving focus.
      const timer = window.setTimeout(() => {
        pickerHeadingRef.current?.focus({ preventScroll: false });
      }, 100);
      return () => window.clearTimeout(timer);
    }
  }, [detected, availableWallets.length]);

  const handleConnect = async (adapter: StellarWalletAdapter) => {
    setLoading(adapter.id);
    setError(null);
    try {
      await adapter.connect();
      const pk = await adapter.getPublicKey();
      setLoading(null);
      if (pk) {
          // Workstream 4: remember WHICH wallet the donor chose so the
          // DonateForm signs through the same adapter (lib/wallet.ts resolves
          // the persisted id via resolveDefaultWallet).
          persistWalletSelection(adapter.id as WalletId);
          trackEvent("wallet_connected", { wallet: adapter.id });
          onConnect(pk);
      }
    } catch (err: unknown) {
      setLoading(null);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("User declined") || msg.includes("rejected") || msg.includes("cancelled")) {
        setError("Connection rejected.");
      } else if (msg.includes("not installed") || msg.includes("not found")) {
        window.open(adapter.installUrl, "_blank");
      } else {
        setError(msg);
      }
    }
  };

  // --- Loading state: still detecting wallets ---
  if (!detected) {
    return (
      <div className="card max-w-sm mx-auto text-center animate-slide-up shadow-indigo">
        <div className="flex items-center justify-center py-8">
          <Spinner />
        </div>
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm font-body">
          Detecting Stellar wallets...
        </p>
      </div>
    );
  }

  // --- No wallets installed ---
  if (availableWallets.length === 0) {
    return (
      <div
        className="card max-w-sm mx-auto text-center animate-slide-up shadow-indigo"
        data-testid="wallet-picker"
      >
        <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center mx-auto mb-5 shadow-lg shadow-[rgba(79,70,229,0.25)]">
          <WalletIcon.freighter />
        </div>
        <h3 className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2">
          {t("wallet.connectTitle")}
        </h3>
        <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-5 font-body leading-relaxed">
          Install a Stellar wallet to start donating. We recommend Freighter for the best experience.
        </p>
        {error && (
          <div className="mb-4 p-3 rounded-xl bg-[rgba(244,63,94,0.08)] border border-[rgba(244,63,94,0.15)] text-[#E11D48] dark:text-[#FB7185] text-sm font-body">
            {error}
          </div>
        )}
        <div className="flex flex-col gap-2">
          <a
            href="https://freighter.app"
            target="_blank"
            rel="noopener noreferrer"
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            <WalletIcon.freighter />
            Install Freighter →
          </a>
          <p className="text-xs text-[#475569] dark:text-[#94A3B8] font-body">
            Also available:{" "}
            <a href="https://albedo.link" target="_blank" rel="noopener noreferrer" className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium">Albedo</a>
            {" · "}
            <a href="https://xbull.app" target="_blank" rel="noopener noreferrer" className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium">xBull</a>
            {" · "}
            <a href="https://walletconnect.com" target="_blank" rel="noopener noreferrer" className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium">WalletConnect</a>
          </p>
        </div>
      </div>
    );
  }

  // --- Wallet picker ---
  return (
    <div
      className="card max-w-sm mx-auto text-center animate-slide-up shadow-indigo"
      data-testid="wallet-picker"
      role="group"
      aria-labelledby="wallet-picker-title"
    >
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-[#4F46E5] to-[#7C3AED] flex items-center justify-center mx-auto mb-5 shadow-lg shadow-[rgba(79,70,229,0.25)]">
        <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a2.25 2.25 0 00-2.25-2.25H15a3 3 0 11-6 0H5.25A2.25 2.25 0 003 12m18 0v6a2.25 2.25 0 01-2.25 2.25H5.25A2.25 2.25 0 013 18v-6m18 0V9M3 12V9m18 0a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 9m18 0V6a2.25 2.25 0 00-2.25-2.25H5.25A2.25 2.25 0 003 6v3" />
        </svg>
      </div>
      <h3
        id="wallet-picker-title"
        ref={pickerHeadingRef}
        tabIndex={-1}
        className="font-display text-xl font-semibold text-[#0F172A] dark:text-[#E2E8F0] mb-2 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-[#4F46E5] dark:focus-visible:outline-[#818CF8] rounded"
      >
        {t("wallet.connectTitle")}
      </h3>
      <p className="text-[#475569] dark:text-[#94A3B8] text-sm mb-5 font-body leading-relaxed">
        {availableWallets.length > 1
          ? `${availableWallets.length} wallets detected. Choose one to connect.`
          : t("wallet.connectDesc")}
      </p>

      {error && (
        <div className="mb-4 p-3 rounded-xl bg-[rgba(244,63,94,0.08)] border border-[rgba(244,63,94,0.15)] text-[#E11D48] dark:text-[#FB7185] text-sm font-body">
          {error}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {availableWallets.map((adapter) => {
          const Icon = WalletIcon[adapter.id] ?? WalletIcon.freighter;
          const isConnecting = loading === adapter.id;
          return (
            <button
              key={adapter.id}
              onClick={() => handleConnect(adapter)}
              disabled={loading !== null}
              className="flex items-center gap-3 w-full p-3 rounded-xl border border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] bg-white dark:bg-[#14142D] hover:border-[rgba(99,102,241,0.35)] hover:bg-[rgba(99,102,241,0.04)] dark:hover:bg-[rgba(129,140,248,0.06)] transition-all text-left group"
              data-testid="wallet-connect-button"
              data-wallet-id={adapter.id}
            >
              <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-[#4F46E5]/10 to-[#7C3AED]/10 dark:from-[#818CF8]/15 dark:to-[#A78BFA]/15 flex items-center justify-center text-[#4F46E5] dark:text-[#818CF8] group-hover:scale-105 transition-transform shrink-0">
                <Icon />
              </div>
              <div className="flex-1 min-w-0">
                <div className="font-display font-semibold text-sm text-[#0F172A] dark:text-[#E2E8F0]">
                  {adapter.name}
                </div>
                <div className="text-xs text-[#475569] dark:text-[#94A3B8] font-body truncate">
                  {adapter.description}
                </div>
              </div>
              {isConnecting ? (
                <Spinner />
              ) : (
                <svg className="w-4 h-4 text-[#94A3B8] group-hover:text-[#4F46E5] dark:group-hover:text-[#818CF8] transition-colors shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                </svg>
              )}
            </button>
          );
        })}
      </div>

      <p className="mt-4 text-xs text-[#475569] dark:text-[#94A3B8] font-body">
        Don&apos;t have a wallet?{" "}
        <a
          href="https://freighter.app"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[#4F46E5] dark:text-[#818CF8] hover:underline font-medium"
        >
          Get Freighter →
        </a>
      </p>
    </div>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
