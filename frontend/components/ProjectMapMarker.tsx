/**
 * components/ProjectMapMarker.tsx
 *
 * A Leaflet Marker for a single ClimateProject rendered inside a
 * react-leaflet MapContainer.  Clicking the marker opens a Leaflet Popup
 * containing a mini project card with:
 *   - Project name, category icon, and location
 *   - Raised / Goal progress bar
 *   - Raised XLM amount
 *   - "Donate →" link that navigates to /donate?project=<id>
 *
 * The marker icon is wrapped in a <button> so the marker is keyboard
 * focusable (WCAG 2.4.7) and announced to screen readers (WCAG 4.1.2).
 * Pressing Enter or Space on the focused marker opens the popup — Leaflet's
 * default click handler still fires for mouse and touch users, so the
 * existing keyboard zoom/pan navigation is unaffected.
 *
 * This component MUST only be rendered client-side (Leaflet has no SSR
 * support).  The parent ProjectMap component handles the dynamic import
 * with ssr:false.
 */
import { useCallback, useMemo, useRef } from "react";
import Link from "next/link";
import { Marker, Popup } from "react-leaflet";
import L, { type LatLngExpression } from "leaflet";
import type { ClimateProject } from "@/utils/types";
import { formatXLM, progressPercent, CATEGORY_ICONS } from "@/utils/format";

interface ProjectMapMarkerProps {
  project: ClimateProject;
  position: LatLngExpression;
}

/**
 * Escape HTML special characters so the project name is safe to embed in
 * the divIcon's HTML/attribute values. Prevents XSS via project names and
 * accidental HTML breakage from quotes/angle brackets.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build an accessible Leaflet DivIcon for a project marker. The icon's HTML
 * is a <button> so the marker is keyboard-focusable and exposed to screen
 * readers. The visible content is a small inline SVG so we don't depend on
 * any image asset being shipped with the bundle.
 */
function buildMarkerIcon(projectName: string): L.DivIcon {
  const safeName = escapeHtml(projectName || "Unknown project");
  return L.divIcon({
    className: "indigopay-marker",
    html: `
      <button
        type="button"
        class="indigopay-marker-btn"
        tabindex="0"
        role="button"
        aria-label="View project: ${safeName}"
        style="background:transparent;border:0;padding:0;cursor:pointer;line-height:0;display:block;"
      >
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36" aria-hidden="true" focusable="false">
          <path d="M12 0C5.373 0 0 5.373 0 12c0 8.5 12 24 12 24S24 20.5 24 12C24 5.373 18.627 0 12 0z" fill="#4F46E5" stroke="#ffffff" stroke-width="1.5"/>
          <circle cx="12" cy="12" r="5" fill="#ffffff" opacity="0.9"/>
        </svg>
      </button>
    `,
    iconSize: [24, 36],
    iconAnchor: [12, 36],
    popupAnchor: [0, -38],
  });
}

export default function ProjectMapMarker({
  project,
  position,
}: ProjectMapMarkerProps) {
  const markerRef = useRef<L.Marker | null>(null);
  const icon = useMemo(() => buildMarkerIcon(project.name), [project.name]);

  /**
   * Open the marker's popup when Enter or Space is pressed. Implements
   * WCAG 2.1.1 (Keyboard) for when no mouse is available — the default
   * click handler is still fired for pointer users.
   */
  const handleKeyDown = useCallback((event: L.LeafletEvent) => {
    const originalEvent = (
      event as L.LeafletKeyboardEvent
    ).originalEvent as KeyboardEvent | undefined;
    if (!originalEvent) return;
    if (originalEvent.key === "Enter" || originalEvent.key === " ") {
      originalEvent.preventDefault();
      markerRef.current?.openPopup();
    }
  }, []);

  const pct = Math.min(
    progressPercent(project.raisedXLM, project.goalXLM),
    100,
  );
  const categoryIcon = CATEGORY_ICONS[project.category] ?? "🌿";

  return (
    <Marker
      ref={markerRef}
      position={position}
      icon={icon}
      eventHandlers={{ keydown: handleKeyDown }}
    >
      <Popup
        // Keep popup open on hover, close on click-outside
        closeButton={true}
        autoPan={true}
        className="indigopay-popup"
        minWidth={220}
        maxWidth={280}
      >
        {/* Mini project card ------------------------------------------------ */}
        <div
          className="flex flex-col gap-2 p-0.5"
          role="region"
          aria-label={`Project: ${project.name}`}
        >
          {/* Header: icon + name */}
          <div className="flex items-start gap-2">
            <span className="text-xl leading-none mt-0.5" aria-hidden="true">
              {categoryIcon}
            </span>
            <div className="min-w-0">
              <p className="font-display font-semibold text-[#0F172A] text-sm leading-snug line-clamp-2">
                {project.name}
              </p>
              <p className="text-xs text-[#4F46E5] font-body mt-0.5 truncate">
                {project.category} · {project.location}
              </p>
            </div>
          </div>

          {/* Progress bar */}
          <div className="space-y-1">
            <div
              className="h-1.5 w-full rounded-full bg-[rgba(99,102,241,0.10)] overflow-hidden"
              role="progressbar"
              aria-valuenow={pct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={`${pct.toFixed(0)}% funded`}
            >
              <div
                className="h-full rounded-full bg-gradient-to-r from-[#4F46E5] to-[#7C3AED] transition-all duration-500"
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-[#4F46E5] font-body">
              <span className="font-semibold">
                {formatXLM(project.raisedXLM, 0)} raised
              </span>
              <span className="text-[#64748B]">{pct.toFixed(0)}%</span>
            </div>
          </div>

          {/* Donate link */}
          <Link
            href={`/donate?project=${project.id}`}
            className="mt-1 block w-full text-center text-xs font-body font-semibold text-white rounded-lg py-1.5 px-3 transition-all focus:outline-none focus:ring-2 focus:ring-[#818CF8] focus:ring-offset-1 hover:opacity-90 active:opacity-80"
            style={{ background: "linear-gradient(135deg, #4F46E5, #7C3AED)" }}
          >
            Donate →
          </Link>
        </div>
      </Popup>
    </Marker>
  );
}
