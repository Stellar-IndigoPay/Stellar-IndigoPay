import { NextResponse, type NextRequest } from "next/server";

import { FOUC_THEME_SCRIPT_HASH } from "@/lib/csp";

const STELLAR_CONNECT = [
  "https://horizon-testnet.stellar.org",
  "https://horizon.stellar.org",
  "https://soroban-testnet.stellar.org",
  "https://soroban.stellar.org",
  "https://friendbot.stellar.org",
].join(" ");

// Leaflet tile servers — the {s} subdomain expands to a/b/c at runtime.
// All three tile subdomains must be allow-listed explicitly.
const LEAFLET_TILE_SOURCES = [
  "https://a.tile.openstreetmap.org",
  "https://b.tile.openstreetmap.org",
  "https://c.tile.openstreetmap.org",
].join(" ");

export function buildCsp(isWidget: boolean): string {
  // API origin: 'self' covers same-origin deploys; NEXT_PUBLIC_API_URL covers
  // deployed backends and CI/E2E environments (e.g. http://localhost:4000).
  // Falls back to localhost:4000 in local dev when the env var is not set.
  const apiUrl = process.env.NEXT_PUBLIC_API_URL
    || (process.env.NODE_ENV === "development" ? "http://localhost:4000" : null);
  const connectSrc = [
    "'self'",
    STELLAR_CONNECT,
    ...(apiUrl ? [apiUrl] : []),
  ].join(" ");

  // The only inline executable script is the pre-hydration FOUC theme script,
  // which has fixed content and is therefore allowed via its SHA-256 hash.
  // A hash is deterministic and cache-safe: SSG / ISR / edge-cached HTML has
  // no per-request nonce, so a nonce-stamped CSP would block every script on
  // those pages. External Next.js bundles load from 'self'. No 'strict-dynamic'
  // is used because it would ignore 'self' and require the nonce we removed.
  //
  // next dev's Fast Refresh runtime (react-refresh-utils) bootstraps modules
  // via eval() and injects inline scripts; production bundles never do. Keep
  // 'unsafe-inline'/'unsafe-eval' strictly dev-only.
  const scriptSrc = [
    "'self'",
    FOUC_THEME_SCRIPT_HASH,
    ...(process.env.NODE_ENV === "development"
      ? ["'unsafe-inline'", "'unsafe-eval'"]
      : []),
  ].join(" ");

  const directives = [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com`,
    "font-src 'self' https://fonts.gstatic.com",
    // OSM tile images are loaded as <img> elements by Leaflet TileLayer.
    // Leaflet marker icons use data: URIs (our inline SVG divIcon).
    `img-src 'self' data: blob: ${LEAFLET_TILE_SOURCES}`,
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    isWidget ? "frame-ancestors *" : "frame-ancestors 'none'",
    // Reporting endpoint for CSP violations. `report-to` (Reporting API) is the
    // modern directive; `report-uri` is kept for browsers that predate it.
    "report-uri /api/csp-report",
    "report-to csp-endpoint",
    // Meaningless (and actively harmful) against a plain-HTTP local dev
    // server: it forces every subresource request to upgrade to HTTPS, and
    // WebKit (unlike Chromium/Firefox, which special-case localhost as
    // already trustworthy) applies that literally — every _next/static
    // script request gets rewritten to https://localhost:PORT, which has no
    // TLS listener, so the whole bundle fails a TLS handshake and the app
    // never hydrates.
    ...(process.env.NODE_ENV === "development" || process.env.E2E_TESTING === "true"
      ? []
      : ["upgrade-insecure-requests"]),
  ];

  return directives.join("; ");
}

export function middleware(request: NextRequest) {
  const isWidget = request.nextUrl.pathname.startsWith("/widget/");
  const csp = buildCsp(isWidget);

  const response = NextResponse.next();
  response.headers.set("Content-Security-Policy", csp);
  // Define the named endpoint referenced by the CSP `report-to` directive.
  response.headers.set("Reporting-Endpoints", 'csp-endpoint="/api/csp-report"');

  return response;
}

export const config = {
  // Skip static assets — CSP is only meaningful on HTML responses.
  matcher: [
    "/((?!_next/static|_next/image|favicon\\.ico|.*\\.(?:png|ico|svg|webp)$).*)",
  ],
};
