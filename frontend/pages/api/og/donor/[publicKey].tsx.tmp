/**
 * pages/api/og/donor/[publicKey].tsx
 * Server-rendered 1200×630 OG image for donor impact profiles.
 * Uses @vercel/og (Satori) on the Edge Runtime.
 *
 * Route: /api/og/donor/:publicKey
 *
 * Caching: Cache-Control set to 3600s (1 hour) for static donor data.
 */

import { ImageResponse } from "@vercel/og";
import type { NextRequest } from "next/server";

export const config = { runtime: "edge" };

// ── Badge mapping ─────────────────────────────────────────────────────────────

const BADGE_EMOJI: Record<string, string> = {
  seedling: "🌱",
  tree: "🌳",
  forest: "🌲",
  earth: "🌍",
};

const BADGE_LABEL: Record<string, string> = {
  seedling: "Seedling",
  tree: "Tree",
  forest: "Forest",
  earth: "Earth Guardian",
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Order of badge tiers, lowest → highest. */
const TIER_ORDER = ["seedling", "tree", "forest", "earth"];

/**
 * Returns the highest badge tier from a list of badges.
 * Mirrors the logic in donors/[publicKey].tsx.
 */
function highestTier(badges: Array<{ tier: string }>): string | null {
  let best: string | null = null;
  let bestIdx = -1;
  for (const b of badges) {
    const idx = TIER_ORDER.indexOf(b.tier);
    if (idx > bestIdx) {
      bestIdx = idx;
      best = b.tier;
    }
  }
  return best;
}

function shortenKey(pk: string): string {
  if (!pk || pk.length < 12) return pk;
  return `${pk.slice(0, 6)}…${pk.slice(-6)}`;
}

function formatXLM(amount: string | number): string {
  const n = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(n)) return "0 XLM";
  return `${n.toLocaleString("en-US", { maximumFractionDigits: 2 })} XLM`;
}

function formatCO2(kg: number): string {
  if (kg >= 1_000_000) return `${(kg / 1_000_000).toFixed(1)}M kg`;
  if (kg >= 1_000) return `${(kg / 1_000).toFixed(1)}k kg`;
  return `${kg.toLocaleString()} kg`;
}

function getBadgeEmoji(tier: string | null | undefined): string {
  if (!tier) return "🌱";
  return BADGE_EMOJI[tier.toLowerCase()] || "🌱";
}

function getBadgeLabel(tier: string | null | undefined): string {
  if (!tier) return "Supporter";
  return BADGE_LABEL[tier.toLowerCase()] || "Supporter";
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface ProfileData {
  publicKey: string;
  displayName?: string;
  totalDonatedXLM: string;
  projectsSupported: number;
  co2OffsetKg?: number;
  badges?: Array<{ tier: string; earnedAt: string }>;
}

// ── Handler ───────────────────────────────────────────────────────────────────

export default async function handler(req: NextRequest) {
  try {
    // Extract publicKey from the URL path: /api/og/donor/{publicKey}
    const { pathname } = req.nextUrl;
    const publicKey = pathname.split("/").pop();

    if (!publicKey || publicKey.length < 10) {
      return new ImageResponse(
        (
          <div
            style={{
              width: 1200,
              height: 630,
              background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)",
              display: "flex",
              flexDirection: "column",
              justifyContent: "center",
              alignItems: "center",
              color: "white",
              fontFamily: "system-ui",
              padding: 80,
            }}
          >
            <div style={{ fontSize: 72, marginBottom: 24 }}>🌿</div>
            <div
              style={{
                fontSize: 36,
                fontWeight: 300,
                opacity: 0.8,
                textAlign: "center",
              }}
            >
              Stellar IndigoPay
            </div>
          </div>
        ),
        {
          width: 1200,
          height: 630,
          headers: {
            "Cache-Control": "public, max-age=3600",
          },
        },
      );
    }

    // Fetch donor profile from the backend API
    const apiUrl =
      process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
    let profile: ProfileData | null = null;

    try {
      const res = await fetch(`${apiUrl}/api/v1/profiles/${publicKey}`, {
        signal: AbortSignal.timeout(3000),
      });

      if (res.ok) {
        const json = await res.json();
        profile = json.data || json;
      }
    } catch {
      // Profile fetch failed — render with minimal data
    }

    // ── Derive display values ────────────────────────────────────────────

    const displayName = profile?.displayName || shortenKey(publicKey);
    const totalDonated = profile?.totalDonatedXLM || "0";
    const co2Offset = profile?.co2OffsetKg || 0;
    const projectsSupported = profile?.projectsSupported || 0;
    const badgeTier = profile?.badges ? highestTier(profile.badges) : null;
    const badgeEmoji = getBadgeEmoji(badgeTier);
    const badgeLabel = getBadgeLabel(badgeTier);

    // ── Determine gradient base color ────────────────────────────────────
    // Darker gradient for higher badge tiers
    const gradientMap: Record<string, string> = {
      seedling: "linear-gradient(135deg, #059669 0%, #10B981 100%)",
      tree: "linear-gradient(135deg, #047857 0%, #059669 100%)",
      forest: "linear-gradient(135deg, #065F46 0%, #047857 100%)",
      earth: "linear-gradient(135deg, #1E40AF 0%, #4F46E5 100%)",
    };
    const gradient =
      badgeTier && gradientMap[badgeTier.toLowerCase()]
        ? gradientMap[badgeTier.toLowerCase()]
        : "linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)";

    return new ImageResponse(
      (
        <div
          style={{
            width: 1200,
            height: 630,
            background: gradient,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            color: "white",
            fontFamily: "system-ui",
            padding: 80,
            position: "relative",
          }}
        >
          {/* Decorative background pattern */}
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              background:
                "radial-gradient(circle at 20% 30%, rgba(255,255,255,0.08) 0%, transparent 50%), radial-gradient(circle at 80% 70%, rgba(255,255,255,0.05) 0%, transparent 50%)",
              display: "flex",
            }}
          />

          {/* Badge emoji */}
          <div style={{ fontSize: 80, marginBottom: 16, lineHeight: 1 }}>
            {badgeEmoji}
          </div>

          {/* Badge label */}
          <div
            style={{
              fontSize: 20,
              fontWeight: 600,
              opacity: 0.85,
              marginBottom: 12,
              letterSpacing: "0.1em",
              textTransform: "uppercase" as const,
            }}
          >
            {badgeLabel}
          </div>

          {/* Donor name */}
          <div
            style={{
              fontSize: 48,
              fontWeight: 700,
              marginBottom: 16,
              textAlign: "center",
              maxWidth: 800,
              lineHeight: 1.2,
            }}
          >
            {displayName}
          </div>

          {/* Impact stats */}
          <div
            style={{
              fontSize: 28,
              opacity: 0.9,
              textAlign: "center",
              marginBottom: 8,
            }}
          >
            {formatXLM(totalDonated)} donated · {formatCO2(co2Offset)} CO₂
            offset
          </div>

          {/* Projects supported */}
          {projectsSupported > 0 && (
            <div
              style={{
                fontSize: 20,
                opacity: 0.7,
                marginBottom: 32,
              }}
            >
              Supporting {projectsSupported} climate project
              {projectsSupported !== 1 ? "s" : ""}
            </div>
          )}

          {/* CTA */}
          <div
            style={{
              fontSize: 22,
              opacity: 0.75,
              borderTop: "1px solid rgba(255,255,255,0.2)",
              paddingTop: 24,
              width: "60%",
              textAlign: "center" as const,
            }}
          >
            Donate on Stellar-IndigoPay → stellar-indigopay.app
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          "Cache-Control": "public, max-age=3600",
        },
      },
    );
  } catch (error) {
    // Fallback error card
    return new ImageResponse(
      (
        <div
          style={{
            width: 1200,
            height: 630,
            background: "linear-gradient(135deg, #0F172A 0%, #1E293B 100%)",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            alignItems: "center",
            color: "white",
            fontFamily: "system-ui",
            padding: 80,
          }}
        >
          <div style={{ fontSize: 72, marginBottom: 24 }}>🌿</div>
          <div
            style={{
              fontSize: 36,
              fontWeight: 700,
              marginBottom: 8,
            }}
          >
            Stellar IndigoPay
          </div>
          <div style={{ fontSize: 20, opacity: 0.6 }}>
            Climate impact made transparent
          </div>
        </div>
      ),
      {
        width: 1200,
        height: 630,
        headers: {
          "Cache-Control": "public, max-age=300",
        },
      },
    );
  }
}
