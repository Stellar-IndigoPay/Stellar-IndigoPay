import posthog from "posthog-js";

export function initAnalytics() {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "production" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY || "", {
    api_host:
      process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com",
    capture_pageview: false,
    persistence: "memory",
    sanitize_properties: (properties) => {
      const sanitized = { ...properties };
      delete sanitized.donorAddress;
      delete sanitized.transactionHash;
      delete sanitized.email;
      if (sanitized.amountXLM) {
        sanitized.amountXLM = bucketAmount(sanitized.amountXLM);
      }
      return sanitized;
    },
  });
}

function bucketAmount(amount: string): string {
  const xlm = parseFloat(amount);
  if (xlm <= 10) return "0-10";
  if (xlm <= 50) return "11-50";
  if (xlm <= 100) return "51-100";
  if (xlm <= 500) return "101-500";
  return "500+";
}

export function trackEvent(
  name: string,
  properties?: Record<string, any>,
) {
  if (process.env.NODE_ENV !== "production") return;
  posthog.capture(name, properties);
}

export function setAnalyticsConsent(hasConsented: boolean) {
  if (hasConsented) {
    posthog.set_config({ persistence: "cookie" });
  } else {
    posthog.set_config({ persistence: "memory" });
  }
}

export { bucketAmount };
