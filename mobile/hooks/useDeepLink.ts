/**
 * hooks/useDeepLink.ts
 * Handles indigopay:// and web+stellar:// deep links — both the custom
 * URL scheme and universal (https) links registered in app.json.
 *
 * Supported URLs:
 *   indigopay://project/123           → /projects/123
 *   indigopay://donate/G...ABC        → /donate/G...ABC
 *   https://indigopay.example.com/project/123 → /projects/123 (universal link)
 *   https://indigopay.example.com/donate/123  → /donate/123   (universal link)
 *   web+stellar:pay?destination=G...&amount=10  → SEP-0007 payment
 *   web+stellar:tx?xdr=AAAA...                  → SEP-0007 transaction signing
 *
 * #906: every non-SEP-0007 URL is parsed and validated by
 * `lib/linkRouter.ts` — the single place scheme/host allowlists and
 * entity-id formats are defined — instead of ad hoc parsing here. A
 * malformed or disallowed URL simply does not navigate (fail closed).
 * SEP-0007 URLs are forwarded to the dedicated SEP-0007 screen, which owns
 * detailed field-level validation (utils/sep0007.ts); this hook only
 * applies the shared length guard before forwarding.
 */
import { useEffect } from "react";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { parseLink, buildRoutePath, MAX_INPUT_LENGTH } from "../lib/linkRouter";

export function useDeepLink() {
  const router = useRouter();

  function handleUrl(url: string | null) {
    if (!url) return;

    // SEP-0007: web+stellar scheme. Field-level validation belongs to the
    // SEP-0007 screen; the router still guards against pathological input.
    if (/^web\+stellar:/i.test(url)) {
      if (url.length > MAX_INPUT_LENGTH) return;
      const encoded = encodeURIComponent(url);
      router.push(`/sep0007?uri=${encoded}` as `${string}`);
      return;
    }

    const result = parseLink(url, url.startsWith("https:") ? "universal_link" : "custom_scheme");
    if (result.status !== "valid") return;

    router.push(buildRoutePath(result.target) as `${string}`);
  }

  useEffect(() => {
    // Handle the link that launched the app (cold start)
    Linking.getInitialURL().then(handleUrl);

    // Handle links received while the app is already open
    const subscription = Linking.addEventListener("url", ({ url }) =>
      handleUrl(url),
    );
    return () => subscription.remove();
  }, []);
}
