import { useEffect, useState } from "react";
import type { AppProps } from "next/app";
import Head from "next/head";
import { useRouter } from "next/router";
import { AnimatePresence } from "framer-motion";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { queryClient, persister } from "@/lib/queryClient";
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
import { initAnalytics, trackEvent } from "@/lib/analytics";
import useOfflineQueueSync from "@/hooks/useOfflineQueueSync";
import { inter, display } from "@/lib/fonts";
import "@/styles/globals.css";

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

  // Issue #1129: drain the offline donation queue on load, on reconnect, and
  // on Service Worker Background Sync nudges (public/sw.js posts the plain
  // string "indigopay-queue-sync") — with the server idempotency pre-check,
  // the conflict toast, and the confirmation notification wired in.
  useOfflineQueueSync();

  // Register the Service Worker for offline app-shell caching (public/sw.js).
  useEffect(() => {
    if (typeof window === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  return (
    <ErrorBoundary>
      <PersistQueryClientProvider
        client={queryClient}
        persistOptions={{ persister }}
      >
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
              <div className={`${inter.variable} ${display.variable}`}>
              <ConnectivityBanner isOnline={isOnline} />
              <SkipToContent />
              <main id="main-content" tabIndex={-1}>
                <OfflineFallback isOnline={isOnline} />
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
      </PersistQueryClientProvider>
    </ErrorBoundary>
  );
}
