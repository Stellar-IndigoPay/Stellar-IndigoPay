import { Html, Head, Main, NextScript } from "next/document";

import { FOUC_THEME_SCRIPT } from "@/lib/csp";

// The single inline executable script (the pre-hydration FOUC theme script)
// is allowed by CSP via its SHA-256 hash (`lib/csp.ts`), not a per-request
// nonce.  That keeps the CSP deterministic across SSG / ISR / edge-cached
// pages, which render at build time without any request header to stamp a
// nonce from (closes #689).  No custom `getInitialProps` is needed here
// anymore, so pages retain Automatic Static Optimisation where possible.
export default function Document() {
  return (
    <Html lang="en">
      <Head>
        <meta name="theme-color" content="#4F46E5" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="default" />
        <meta name="apple-mobile-web-app-title" content="Stellar IndigoPay" />
        <meta name="mobile-web-app-capable" content="yes" />
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/icon-192.png" />
      </Head>
      <body>
        {/* Pre-hydration FOUC prevention. Reads localStorage directly and
            applies (or removes) the `.dark` class on <html> BEFORE React
            mounts, mirroring `lib/theme.tsx`. Its content is fixed, so CSP
            allows it by SHA-256 hash with no nonce. */}
        <script
          dangerouslySetInnerHTML={{ __html: FOUC_THEME_SCRIPT }}
        />
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
