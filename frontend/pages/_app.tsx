import type { AppProps } from "next/app";
import Head from "next/head";
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
export default function App({ Component, pageProps }: AppProps) {
  return (
    <ErrorBoundary>
      <ThemeProvider>
        <I18nProvider>
          <PriceProvider>
            <WalletProvider>
              <Head>
                <title>Stellar IndigoPay</title>
                <meta
                  name="description"
                  content="Donate to climate projects using Stellar USDC and XLM. 100% goes directly, on-chain and transparent."
                />
                <meta name="viewport" content="width=device-width, initial-scale=1" />
              </Head>
              <Component {...pageProps} />
              <ThemeTiedToaster />
            </WalletProvider>
          </PriceProvider>
        </I18nProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
