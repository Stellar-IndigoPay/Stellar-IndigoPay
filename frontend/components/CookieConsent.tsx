import { useState, useEffect } from "react";
import { setAnalyticsConsent } from "@/lib/analytics";

export default function CookieConsent() {
  const [consent, setConsent] = useState<boolean | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("cookie-consent");
    if (stored === "true") {
      setConsent(true);
      setAnalyticsConsent(true);
    } else if (stored === "false") {
      setConsent(false);
    }
  }, []);

  const acceptCookies = () => {
    localStorage.setItem("cookie-consent", "true");
    setConsent(true);
    setAnalyticsConsent(true);
  };

  const declineCookies = () => {
    localStorage.setItem("cookie-consent", "false");
    setConsent(false);
    setAnalyticsConsent(false);
  };

  if (consent !== null) return null;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 bg-white dark:bg-[#14142D] border-t border-[rgba(99,102,241,0.15)] dark:border-[rgba(129,140,248,0.20)] p-4 shadow-2xl animate-slide-up">
      <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center gap-4">
        <p className="text-sm text-[#475569] dark:text-[#94A3B8] flex-1 font-body">
          We use cookies to understand how you use IndigoPay and improve the
          platform. No personal data is collected.
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
