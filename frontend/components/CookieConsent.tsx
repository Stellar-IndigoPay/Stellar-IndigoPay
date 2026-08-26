import { useState, useEffect } from "react";
import { getConsent, setConsent, onConsentChange, ConsentState } from "@/lib/consent";

export default function CookieConsent() {
  const [consent, setConsentState] = useState<ConsentState>("undecided");

  useEffect(() => {
    // Initial state
    setConsentState(getConsent());

    // Listen to external changes (e.g. from settings)
    const unsubscribe = onConsentChange(setConsentState);
    return unsubscribe;
  }, []);

  const acceptCookies = () => {
    setConsent("granted");
  };

  const declineCookies = () => {
    setConsent("denied");
  };

  if (consent !== "undecided") return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-[#14142D] border-t border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] p-4 shadow-2xl animate-slide-up">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center gap-4">
        <p className="text-sm text-[#475569] dark:text-[#94A3B8] flex-1 font-body">
          We use cookies and analytics to understand how you use IndigoPay and improve the
          platform. View our <a href="/docs/data-inventory" className="underline text-[#4F46E5] dark:text-[#818CF8]">Data Inventory</a> to see what we collect. No personal data is stored without consent.
        </p>
        <div className="flex gap-3 flex-shrink-0">
          <button
            onClick={acceptCookies}
            className="px-5 py-2 rounded-xl text-sm font-semibold font-body bg-[#4F46E5] text-white hover:bg-[#6366F1] transition-colors"
          >
            Accept
          </button>
          <button
            onClick={declineCookies}
            className="px-5 py-2 rounded-xl text-sm font-semibold font-body bg-[rgba(99,102,241,0.08)] dark:bg-[rgba(129,140,248,0.10)] text-[#4F46E5] dark:text-[#818CF8] hover:bg-[rgba(99,102,241,0.15)] dark:hover:bg-[rgba(129,140,248,0.20)] transition-colors"
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  );
}
