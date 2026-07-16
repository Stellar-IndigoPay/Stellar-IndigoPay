/**
 * pages/widget/[projectId].tsx — Embeddable Donation Widget
 *
 * A standalone widget that project owners can embed on their own websites
 * via <iframe>. Supports cross-origin embedding, theme customization via
 * URL query params, and communicates donation events to the parent page
 * via postMessage.
 *
 * postMessage API:
 *   Widget → Parent:
 *     indigopay:resize            { height: number }
 *     indigopay:donation-complete { amount: string, txHash: string, projectId: string }
 *     indigopay:error             { message: string }
 *   Parent → Widget:
 *     indigopay:set-theme         { primary?: string, text?: string, background?: string }
 */

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/router";
import Head from "next/head";
import DonateForm from "@/components/DonateForm";
import WalletConnect from "@/components/WalletConnect";
import { fetchProject } from "@/lib/api";
import { formatXLM, formatCO2, progressPercent } from "@/utils/format";
import type { ClimateProject } from "@/utils/types";

// ---------------------------------------------------------------------------
// Theme type
// ---------------------------------------------------------------------------

interface WidgetTheme {
  primary: string;
  text: string;
  background: string;
  radius: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): string {
  const clean = hex.replace("#", "").slice(0, 6);
  const num = parseInt(clean, 16);
  if (isNaN(num)) return "79, 70, 229";
  return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
}

function parseTheme(query: Record<string, string | string[] | undefined>): WidgetTheme {
  const get = (key: string, fallback: string): string => {
    const val = query[key];
    return typeof val === "string" && val.length > 0 ? val : fallback;
  };
  return {
    primary: get("primary", "#4F46E5"),
    text: get("text", "#0F172A"),
    background: get("background", "#FFFFFF"),
    radius: get("radius", "12"),
  };
}

// ---------------------------------------------------------------------------
// Widget Page
// ---------------------------------------------------------------------------

export default function WidgetPage() {
  const router = useRouter();
  const { projectId } = router.query;

  const [project, setProject] = useState<ClimateProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [theme, setTheme] = useState<WidgetTheme>(() => parseTheme(router.query as Record<string, string>));

  // Re-parse theme when query params change (Next.js client-side hydration)
  useEffect(() => {
    if (router.isReady) {
      setTheme(parseTheme(router.query as Record<string, string>));
    }
  }, [router.isReady, router.query]);

  // ── Fetch project ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    fetchProject(projectId as string)
      .then(setProject)
      .catch((err) => setError(err?.response?.status === 404 ? "Project not found" : "Failed to load project"))
      .finally(() => setLoading(false));
  }, [projectId]);

  // ── ResizeObserver → postMessage height updates ────────────────────────
  const sendResize = useCallback(() => {
    if (typeof window === "undefined") return;
    window.parent.postMessage(
      {
        type: "indigopay:resize",
        height: document.documentElement.scrollHeight,
      },
      "*"
    );
  }, []);

  useEffect(() => {
    const observer = new ResizeObserver(() => sendResize());
    observer.observe(document.body);
    sendResize(); // initial height
    return () => observer.disconnect();
  }, [sendResize]);

  // ── Listen for parent → widget theme updates ──────────────────────────
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.type === "indigopay:set-theme") {
        const data = event.data as { primary?: string; text?: string; background?: string; radius?: string };
        setTheme((prev) => ({
          primary: data.primary || prev.primary,
          text: data.text || prev.text,
          background: data.background || prev.background,
          radius: data.radius || prev.radius,
        }));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // ── Donation complete handler ──────────────────────────────────────────
  const handleDonationSuccess = useCallback(() => {
    window.parent.postMessage(
      {
        type: "indigopay:donation-complete",
        projectId: projectId as string,
      },
      "*"
    );
  }, [projectId]);

  // ── Wallet connect handler ────────────────────────────────────────────
  const handleConnect = useCallback((pk: string) => {
    setPublicKey(pk);
    sendResize();
  }, [sendResize]);

  // ── Error notification to parent ───────────────────────────────────────
  useEffect(() => {
    if (error) {
      window.parent.postMessage(
        { type: "indigopay:error", message: error },
        "*"
      );
    }
  }, [error]);

  // ── CSS custom properties from theme ───────────────────────────────────
  const cssVars = {
    "--igp-primary": theme.primary,
    "--igp-text": theme.text,
    "--igp-bg": theme.background,
    "--igp-radius": `${theme.radius}px`,
  } as React.CSSProperties;

  // ── Render ─────────────────────────────────────────────────────────────
  return (
    <>
      <Head>
        <meta name="robots" content="noindex, nofollow" />
      </Head>

      <div
        style={{
          ...cssVars,
          fontFamily: "system-ui, -apple-system, sans-serif",
          maxWidth: "420px",
          margin: "0 auto",
          padding: "16px",
          background: "var(--igp-bg)",
          borderRadius: "var(--igp-radius)",
          color: "var(--igp-text)",
        }}
      >
        {/* ── Loading skeleton ─────────────────────────────────────────── */}
        {loading && (
          <div className="animate-pulse space-y-3">
            <div
              className="h-20 rounded-t-xl"
              style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.2)` }}
            />
            <div className="space-y-2 p-2">
              <div className="h-4 rounded w-3/4" style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.12)` }} />
              <div className="h-3 rounded w-1/2" style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.08)` }} />
              <div className="h-10 rounded" style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.15)` }} />
            </div>
          </div>
        )}

        {/* ── Error state ──────────────────────────────────────────────── */}
        {!loading && (error || !project) && (
          <div className="text-center py-8">
            <div className="text-4xl mb-3">⚠️</div>
            <p className="text-sm opacity-70">{error || "Project not found"}</p>
          </div>
        )}

        {/* ── Widget content ───────────────────────────────────────────── */}
        {!loading && project && (
          <div
            className="rounded-xl overflow-hidden shadow-lg border"
            style={{ borderColor: `rgba(${hexToRgb(theme.primary)}, 0.15)` }}
          >
            {/* Header */}
            <div
              className="p-4 text-white"
              style={{
                background: `linear-gradient(135deg, ${theme.primary}, ${theme.primary}cc)`,
              }}
            >
              <h3 className="text-lg font-bold truncate">{project.name}</h3>
              <p className="text-sm opacity-90 truncate">{project.category} &middot; {project.location}</p>
            </div>

            {/* Content */}
            <div className="p-4 space-y-4" style={{ background: "var(--igp-bg)" }}>
              {/* Progress bar */}
              <div>
                <div className="flex justify-between items-baseline mb-2">
                  <p className="text-sm font-semibold">
                    {formatXLM(project.raisedXLM)} raised
                  </p>
                  <p className="text-xs opacity-60">
                    {progressPercent(project.raisedXLM, project.goalXLM)}% of {formatXLM(project.goalXLM)}
                  </p>
                </div>
                <div className="h-2 rounded-full overflow-hidden" style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.12)` }}>
                  <div
                    className="h-full transition-all duration-500 rounded-full"
                    style={{
                      width: `${Math.min(progressPercent(project.raisedXLM, project.goalXLM), 100)}%`,
                      background: `linear-gradient(90deg, ${theme.primary}, ${theme.primary}dd)`,
                    }}
                  />
                </div>
              </div>

              {/* Stats grid */}
              <div className="grid grid-cols-2 gap-3">
                <div
                  className="p-3 rounded-xl text-center"
                  style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.06)` }}
                >
                  <p className="text-2xl font-bold">{project.donorCount.toLocaleString()}</p>
                  <p className="text-xs opacity-60 font-semibold mt-1">Donors</p>
                </div>
                <div
                  className="p-3 rounded-xl text-center"
                  style={{ backgroundColor: `rgba(${hexToRgb(theme.primary)}, 0.06)` }}
                >
                  <p className="text-2xl font-bold">{formatCO2(project.co2OffsetKg)}</p>
                  <p className="text-xs opacity-60 font-semibold mt-1">CO₂ Offset</p>
                </div>
              </div>

              {/* Wallet Connect or Donate Form */}
              <div>
                {publicKey ? (
                  <DonateForm
                    project={project}
                    publicKey={publicKey}
                    onSuccess={handleDonationSuccess}
                  />
                ) : (
                  <WalletConnect onConnect={handleConnect} />
                )}
              </div>
            </div>

            {/* Footer */}
            <div
              className="px-4 py-2.5 border-t text-center"
              style={{
                borderColor: `rgba(${hexToRgb(theme.primary)}, 0.1)`,
                background: `rgba(${hexToRgb(theme.primary)}, 0.03)`,
              }}
            >
              <a
                href="https://stellar-indigopay.app"
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs transition-colors hover:underline"
                style={{ color: `rgba(${hexToRgb(theme.primary)}, 0.6)` }}
              >
                Powered by Stellar IndigoPay
              </a>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
