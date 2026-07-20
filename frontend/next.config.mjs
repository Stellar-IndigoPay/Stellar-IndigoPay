import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */

// ---------------------------------------------------------------------------
// Content Security Policy
// ---------------------------------------------------------------------------
// The LIVE CSP (with a per-request nonce) is generated dynamically in
// middleware.ts.  The constants below are the canonical allowlist reference
// and provide a static fallback for any edge-case that bypasses middleware
// (e.g. raw static-file serving without Next.js runtime).
//
// connect-src covers:
//   • Stellar Horizon (testnet + mainnet) — REST API + EventSource streaming
//   • Soroban RPC (testnet + mainnet)     — Soroban simulate/send calls
//   • Stellar Friendbot                    — testnet account funding
//   • CoinGecko                            — XLM/USD spot price
//
// In production set NEXT_PUBLIC_API_URL to your deployed backend; the 'self'
// origin already covers same-domain backends.  In local dev middleware.ts
// also appends http://localhost:4000.
// ---------------------------------------------------------------------------

const STELLAR_CONNECT = [
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
  "https://soroban-testnet.stellar.org",
  "https://soroban.stellar.org",
  "https://friendbot.stellar.org",
].join(" ");

// OpenStreetMap tile subdomains used by Leaflet's TileLayer
const LEAFLET_TILE_SOURCES = [
  "https://a.tile.openstreetmap.org",
  "https://b.tile.openstreetmap.org",
  "https://c.tile.openstreetmap.org",
].join(" ");

// unpkg serves the Leaflet CSS (dynamically injected by ProjectMap.tsx)
const UNPKG = "https://unpkg.com";

function buildStaticCsp(allowFraming = false) {
  const frameAncestors = allowFraming
    ? "frame-ancestors *"
    : "frame-ancestors 'none'";
  return [
    "default-src 'self'",
    // Static fallback uses unsafe-inline; middleware.ts replaces this with a
    // nonce + strict-dynamic pair which achieves an A grade on csp-evaluator.
    "script-src 'self' 'unsafe-inline'",
    // unpkg serves the Leaflet CSS stylesheet loaded dynamically in ProjectMap.
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${UNPKG}`,
    "font-src 'self' https://fonts.gstatic.com",
    // OSM tiles loaded as images; Leaflet marker icons use data: URIs.
    `img-src 'self' data: blob: ${LEAFLET_TILE_SOURCES}`,
    `connect-src 'self' ${STELLAR_CONNECT} https://api.coingecko.com`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestors,
    "upgrade-insecure-requests",
  ].join("; ");
}

const nextConfig = {
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["@sentry/nextjs"],
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
  async headers() {
    return [
      {
        // Applied to every route.  middleware.ts overrides Content-Security-Policy
        // with the nonce-stamped version for all HTML responses.
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: buildStaticCsp(false) },
          // Security headers (Issue #472)
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        // Widget pages are intentionally embeddable by third-party sites.
        // Override frame-ancestors to allow cross-origin framing (issue #74).
        // X-Frame-Options is omitted by not including it in this header set;
        // modern browsers respect CSP frame-ancestors * instead.
        source: "/widget/:path*",
        headers: [
          { key: "Content-Security-Policy", value: buildStaticCsp(true) },
        ],
      },
    ];
  },
};

// Wrap with Sentry so source maps upload, instrumentation, and the
// /monitoring tunnel route are auto-configured.
//
// withSentryConfig takes three arguments in v7:
//   1. nextConfig  — the Next.js config object
//   2. sentryWebpackPluginOptions — options forwarded to @sentry/webpack-plugin
//      (release, authToken, org, project, etc.)
//   3. sentryOptions — SDK behaviour options (disableServerWebpackPlugin, etc.)
//
// The Sentry webpack plugin (source-map upload + release creation) only runs
// when SENTRY_AUTH_TOKEN is present. Without it the plugin tries to call the
// Sentry CLI to detect the release version, which fails the build. Disabling
// both server and client webpack plugins when the token is absent is safe —
// source-map upload is a CI/prod concern, not required for the app to run.
//
// Build-time env vars (set these in CI / prod):
//   SENTRY_DSN                    - public DSN
//   SENTRY_ORG / SENTRY_PROJECT / SENTRY_AUTH_TOKEN - source-map upload
//   SENTRY_RELEASE                - `git rev-parse --short HEAD` (or commit SHA)
// `silent: !process.env.CI` keeps build logs clean locally while still
// printing Sentry output in CI.
const hasSentryAuth = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(
  nextConfig,
  // Second arg: Sentry webpack plugin options (source-map upload config)
  {
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    release: process.env.SENTRY_RELEASE,
    silent: !process.env.CI,
    widenClientFileUpload: true,
    hideSourceMaps: true,
  },
  // Third arg: SDK / webpack plugin enable/disable options
  {
    disableLogger: true,
    transpileClientSDK: true,
    // Disable the Sentry webpack plugin (which runs the Sentry CLI to upload
    // source maps) when no auth token is available. Without this guard the CLI
    // fails the build trying to auto-detect the release version.
    disableServerWebpackPlugin: !hasSentryAuth,
    disableClientWebpackPlugin: !hasSentryAuth,
  },
);
