import { useEffect, useState } from "react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export default function InstallPrompt() {
  const [isVisible, setIsVisible] = useState(false);
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const dismissed = window.localStorage.getItem("indigopay-install-dismissed") === "true";
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);

    if (dismissed || isStandalone) return;

    const handleBeforeInstallPrompt = (event: Event) => {
      event.preventDefault();
      setDeferredPrompt(event as BeforeInstallPromptEvent);
      setIsVisible(true);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setIsVisible(false);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  if (!isVisible) return null;

  const dismiss = () => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem("indigopay-install-dismissed", "true");
    setIsVisible(false);
  };

  const install = async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    setIsVisible(false);
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-2xl border border-[rgba(99,102,241,0.16)] bg-white/95 p-4 shadow-2xl backdrop-blur dark:bg-[#0F172A]/95">
      <p className="text-sm font-semibold text-[#0F172A] dark:text-[#E2E8F0]">
        Install Stellar IndigoPay
      </p>
      <p className="mt-1 text-sm text-[#475569] dark:text-[#94A3B8]">
        Use the app offline and keep your donation flow handy on the home screen.
      </p>
      <div className="mt-4 flex gap-2">
        <button
          onClick={install}
          className="btn-primary rounded-full px-3 py-2 text-sm"
        >
          Install
        </button>
        <button
          onClick={dismiss}
          className="rounded-full border border-[rgba(99,102,241,0.16)] px-3 py-2 text-sm text-[#475569] dark:text-[#94A3B8]"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
