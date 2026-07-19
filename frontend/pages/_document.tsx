import Document, {
  Html,
  Head,
  Main,
  NextScript,
  type DocumentContext,
  type DocumentInitialProps,
} from "next/document";

interface Props extends DocumentInitialProps {
  nonce?: string;
}

// Class-based Document is required to read per-request headers (the nonce
// injected by middleware.ts) and forward it to <Head> and <NextScript> so
// every script tag in the HTML carries the matching CSP nonce attribute.
// Having getInitialProps here also opts all pages out of Automatic Static
// Optimisation, ensuring _document always runs server-side per request.
class MyDocument extends Document<Props> {
  static async getInitialProps(ctx: DocumentContext): Promise<Props> {
    const initialProps = await Document.getInitialProps(ctx);
    const raw = ctx.req?.headers?.["x-nonce"];
    const nonce = typeof raw === "string" ? raw : undefined;
    return { ...initialProps, nonce };
  }

  render() {
    const { nonce } = this.props;
    // Pre-hydration FOUC prevention. The inline script reads the
    // `indigopay-theme` value from localStorage and applies (or removes)
    // the `.dark` class on <html> BEFORE React mounts, which keeps the
    // first paint at the user's preferred palette. It mirrors the
    // logic in `lib/theme.tsx`'s `applyThemeToDocument`.
    return (
      <Html lang="en">
        <Head nonce={nonce}>
          <meta name="theme-color" content="#4F46E5" />
          <meta name="apple-mobile-web-app-capable" content="yes" />
          <meta name="apple-mobile-web-app-status-bar-style" content="default" />
          <meta name="apple-mobile-web-app-title" content="Stellar IndigoPay" />
          <meta name="mobile-web-app-capable" content="yes" />
          <link rel="manifest" href="/manifest.json" />
          <link rel="apple-touch-icon" href="/icon-192.png" />
          {/* The inline body script below is statically stringified — it
              reads `localStorage` directly rather than DOM meta tags, so
              no `<meta name="csp-nonce">` echo is needed here. The script
              also carries `nonce={nonce}` so middleware-stamped CSPs will
              accept it. */}
        </Head>
        <body>
          <script
            nonce={nonce}
            dangerouslySetInnerHTML={{
              __html: `(function(){try{var k="stellar-indigopay-theme";var m=window.localStorage.getItem(k);var sys=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches;var d=false;if(m==="dark"){d=true}else if(m==="light"){d=false}else if(sys){d=true}var r=document.documentElement;if(d){r.classList.add("dark");r.style.colorScheme="dark"}else{r.classList.remove("dark");r.style.colorScheme="light"}}catch(e){}})();`,
            }}
          />
          <Main />
          <NextScript nonce={nonce} />
        </body>
      </Html>
    );
  }
}

export default MyDocument;
