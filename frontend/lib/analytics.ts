import type { PostHog } from "posthog-js";

let posthogInstance: PostHog | null = null;

export async function initAnalytics() {
  if (typeof window === "undefined") return;
  if (process.env.NODE_ENV !== "production" || !process.env.NEXT_PUBLIC_POSTHOG_KEY) return;

  const posthogModule = await import("posthog-js");
  posthogInstance = posthogModule.default as unknown as PostHog;

  posthogInstance.init(process.env.NEXT_PUBLIC_POSTHOG_KEY || "", {
    api_host:
      process.env.NEXT_PUBLIC_POSTHOG_HOST || "https://app.posthog.com",
    capture_pageview: false,
    persistence: "localStorage",
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
  isInitialized = true;
}

export function initAnalytics() {
  if (typeof window === "undefined") return;

  const currentConsent = getConsent();
  if (currentConsent === "granted") {
    doInit();
  }

  // Handle mid-session consent changes
  onConsentChange((newConsent) => {
    if (newConsent === "granted") {
      doInit();
      if (isInitialized) {
        posthog.opt_in_capturing();
      }
    } else if (newConsent === "denied") {
      if (isInitialized) {
        posthog.opt_out_capturing({ clear_persistence: true });
        posthog.reset(true);
      }
    }
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
  if (posthogInstance) {
    posthogInstance.capture(name, properties);
  }
}

export function setAnalyticsConsent(hasConsented: boolean) {
  if (posthogInstance) {
    if (hasConsented) {
      posthogInstance.set_config({ persistence: "cookie" });
    } else {
      posthogInstance.set_config({ persistence: "memory" });
    }
  }
}

export { bucketAmount };
