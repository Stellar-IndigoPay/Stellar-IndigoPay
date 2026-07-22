import { useEffect, useState } from "react";
import type { AppProps } from "next/app";
import Head from "next/head";
import { useRouter } from "next/router";
import { AnimatePresence } from "framer-motion";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SkipToContent from "@/components/SkipToContent";
import PageTransition from "@/components/PageTransition";
import CookieConsent from "@/components/CookieConsent";
import { ThemeTiedToaster } from "@/components/ThemeTiedToaster";
import { ThemeProvider } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n";
import { PriceProvider } from "@/lib/priceContext";
import { WalletProvider } from "@/lib/WalletProvider";
import { ErrorBoundary } from "@/lib/ErrorBoundary";
import useOnlineStatus from "@/hooks/useOnlineStatus";
import useShortcuts from "@/hooks/useShortcuts";
import GlobalSearchModal from "@/components/GlobalSearchModal";
import ConnectivityBanner from "@/components/ConnectivityBanner";
import OfflineFallback from "@/components/OfflineFallback";
import InstallPrompt from "@/components/InstallPrompt";
import { syncQueuedDonations } from "@/lib/offlineDonationQueue";
import { recordDonation } from "@/lib/api";
import { initAnalytics, trackEvent } from "@/lib/analytics";
import { inter, display } from "@/lib/fonts";
import "@/styles/globals.css";

// ThemeTiedToaster keeps the sonner toast palette in sync with the
// resolved effective theme.
// ErrorBoundary is the OUTERMOST provider so it can catch render-time
// exceptions in any of the providers below it (Theme, I18n, Price,
// Wallet) instead of leaving the user with a blank shell.
// SkipToContent lives at the very top so it is the first focusable
// element on the page (satisfies WCAG 2.4.1 Bypass Blocks).
export default function App({ Component, pageProps }: AppProps) {
  const router = useRouter();
  const isOnline = useOnlineStatus();
  const [searchOpen, setSearchOpen] = useState(false);

  useShortcuts([
    { key: "k", meta: true, handler: () => setSearchOpen(true), description: "Open search" },
    { key: "h", ctrl: true, handler: () => router.push("/"), description: "Go home" },
    { key: "d", ctrl: true, handler: () => router.push("/dashboard"), description: "Dashboard" },
  ]);

  useEffect(() => {
    const handleRouteChange = () => {
      setTimeout(() => {
        const mainContent = document.getElementById("main-content");
        if (mainContent) {
          mainContent.focus();
        } else {
          document.querySelector("h1")?.focus();
        }
      }, 100);
    };

    router.events.on("routeChangeComplete", handleRouteChange);
    return () => router.events.off("routeChangeComplete", handleRouteChange);
  }, [router]);

  // Create QueryClient once per session so cache survives page navigations.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000, // 30s default
            retry: 2,
            refetchOnWindowFocus: true,
          },
        },
      }),
  );

  useEffect(() => {
    initAnalytics();
  }, []);

  useEffect(() => {
    const handleRouteChange = (url: string) => {
      trackEvent("page_viewed", { url });
    };
    router.events.on("routeChangeComplete", handleRouteChange);
    return () => {
      router.events.off("routeChangeComplete", handleRouteChange);
    };
  }, [router.events]);

  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;

    const handleOnlineSync = () => {
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
    };

    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "sync-queued-donations") {
        handleOnlineSync();
      }
    });
    window.addEventListener("online", handleOnlineSync);

    handleOnlineSync();

    return () => {
      window.removeEventListener("online", handleOnlineSync);
    };
  }, []);
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <I18nProvider>
            <PriceProvider>
              <WalletProvider>
              <Head>
                <title>
                  Stellar-IndigoPay — Fund the planet. One XLM at a time.
                </title>
                <meta
                  name="description"
                  content="Donate directly to verified climate projects on Stellar. 100% on-chain, zero fees, maximum impact."
                />
                <meta
                  name="viewport"
                  content="width=device-width, initial-scale=1"
                />
              </Head>
              {/* Font variable injection — next/font injects CSS custom properties
                  so Tailwind can reference them. Apply to the outermost wrapper
                  consumed by the ThemeProvider's rendered div. */}
              <div className={`${inter.variable} ${display.variable}`}>
              <ConnectivityBanner isOnline={isOnline} />
              <SkipToContent />
              <main id="main-content" tabIndex={-1}>
                <OfflineFallback isOnline={isOnline} />
                {/* `initial={false}` prevents the entrance animation on the
                    first SSR paint; `mode="wait"` lets the outgoing page
                    finish exiting before the incoming one mounts, which keeps
                    route changes smooth for both forward and back/forward
                    navigations. Keying by `router.asPath` (including the
                    query string) ensures dynamic routes animate too. */}
                <AnimatePresence mode="wait" initial={false}>
                  <PageTransition key={router.asPath}>
                    <Component {...pageProps} />
                  </PageTransition>
                </AnimatePresence>
              </main>
              <CookieConsent />
              <InstallPrompt />
              <ThemeTiedToaster />
              {searchOpen && <GlobalSearchModal onClose={() => setSearchOpen(false)} />}
              </div>
              </WalletProvider>
            </PriceProvider>
          </I18nProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
