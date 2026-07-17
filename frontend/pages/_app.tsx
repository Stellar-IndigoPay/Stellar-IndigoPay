import type { AppProps } from "next/app";
import Head from "next/head";
import SkipToContent from "@/components/SkipToContent";
import { ThemeTiedToaster } from "@/components/ThemeTiedToaster";
import { ThemeProvider } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n";
import { PriceProvider } from "@/lib/priceContext";
import { WalletProvider } from "@/lib/WalletProvider";
import { ErrorBoundary } from "@/lib/ErrorBoundary";
import "@/styles/globals.css";

// ThemeTiedToaster keeps the sonner toast palette in sync with the
// resolved effective theme.
// ErrorBoundary is the OUTERMOST provider so it can catch render-time
// exceptions in any of the providers below it (Theme, I18n, Price,
// Wallet) instead of leaving the user with a blank shell.
// SkipToContent lives at the very top so it is the first focusable
// element on the page (satisfies WCAG 2.4.1 Bypass Blocks).
export default function App({ Component, pageProps }: AppProps) {
  return (
    <ErrorBoundary>
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
              <SkipToContent />
              <main id="main-content" tabIndex={-1}>
                <Component {...pageProps} />
              </main>
              <ThemeTiedToaster />
            </WalletProvider>
          </PriceProvider>
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
