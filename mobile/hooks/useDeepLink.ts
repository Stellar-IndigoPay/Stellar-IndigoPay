/**
 * hooks/useDeepLink.ts
 * Handles indigopay:// and web+stellar:// deep links.
 *
 * Supported URLs:
 *   indigopay://project/123       → /projects/123
 *   indigopay://donate/G...ABC    → /donate/G...ABC
 *   web+stellar:pay?destination=G...&amount=10  → SEP-0007 payment
 *   web+stellar:tx?xdr=AAAA...    → SEP-0007 transaction signing
 */
import { useEffect } from "react";
import * as Linking from "expo-linking";
import { useRouter } from "expo-router";
import { parseDeepLinkUrl } from "../utils/notifications";

export function useDeepLink() {
  const router = useRouter();

  function handleUrl(url: string | null) {
    if (!url) return;

    // SEP-0007: web+stellar scheme
    if (url.startsWith("web+stellar:")) {
      const encoded = encodeURIComponent(url);
      router.push(`/wallet/sep0007?uri=${encoded}`);
      return;
    }

    const { path, queryParams } = Linking.parse(url);
    if (!path) return;

    const [segment, param] = path.replace(/^\//, "").split("/");
    if (!param) return;

    if (segment === "project") {
      router.push(`/projects/${param}`);
    } else if (segment === "donate") {
      router.push(`/donate/${param}`);
    }
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
