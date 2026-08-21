/**
 * components/ProjectMap.tsx
 *
 * A full-viewport Leaflet world map that renders active climate project
 * markers. Each marker opens a mini popup card (see ProjectMapMarker).
 *
 * ⚠ Leaflet has no server-side rendering support — this component MUST be
 *   imported with `{ ssr: false }` via next/dynamic:
 *
 *   ```ts
 *   const ProjectMap = dynamic(() => import('@/components/ProjectMap'), { ssr: false });
 *   ```
 *
 * Tile provider: OpenStreetMap (no API key required, free to use under ODbL).
 * Marker icons: each ProjectMapMarker renders its own accessible DivIcon
 * (inline SVG wrapped in a focusable <button>) so we don't depend on
 * Leaflet's image assets, which break under webpack/Next.js bundling.
 */
"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { MapContainer, TileLayer, ZoomControl } from "react-leaflet";
import type { ClimateProject } from "@/utils/types";
import { geocodeLocation, jitterCoords } from "@/utils/geocode";
import ProjectMapMarker from "./ProjectMapMarker";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ProjectMapProps {
  /** Active climate projects to pin on the map. */
  projects: ClimateProject[];
}

// ── Component ──────────────────────────────────────────────────────────────────

import "leaflet/dist/leaflet.css";

export default function ProjectMap({ projects }: ProjectMapProps) {
  const [tileError, setTileError] = useState(false);
  const [tileKey, setTileKey] = useState(0);
  const retryCount = useRef(0);

  const handleTileError = useCallback(() => {
    if (retryCount.current < 3) {
      const timeout = Math.pow(2, retryCount.current) * 1000;
      setTimeout(() => {
        retryCount.current += 1;
        setTileKey((prev) => prev + 1);
      }, timeout);
    } else {
      setTileError(true);
    }
  }, []);

  const handleRetry = useCallback(() => {
    retryCount.current = 0;
    setTileError(false);
    setTileKey((prev) => prev + 1);
  }, []);

  // Leaflet needs the CSS — import it once at runtime (not at module level so
  // it doesn't run on the server via accidental imports).
  useEffect(() => {
    // Only import once; subsequent HMR reloads skip this because the link
    // element already exists in the document head.
    if (
      typeof document !== "undefined" &&
      !document.head.querySelector('link[href*="leaflet"]')
    ) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
      link.integrity = "sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=";
      link.crossOrigin = "anonymous";
      document.head.appendChild(link);
    }
  }, []);

  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[20, 10]}
        zoom={2}
        minZoom={2}
        maxZoom={18}
        scrollWheelZoom={true}
        zoomControl={false}
        className="h-full w-full"
        // Restrict panning so users can't scroll past the poles
        maxBounds={[
          [-90, -180],
          [90, 180],
        ]}
        maxBoundsViscosity={1.0}
        aria-label="World map of active climate projects"
      >
        {/* OpenStreetMap tile layer — no API key needed */}
        <TileLayer
          key={`osm-tiles-${tileKey}`}
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
          maxZoom={19}
          eventHandlers={{ tileerror: handleTileError }}
          errorTileUrl="data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="
        />

        {/* Custom positioned zoom control (bottom-right avoids navbar overlap) */}
        <ZoomControl position="bottomright" />

        {/* Project markers */}
        {projects.map((project) => {
          const base = geocodeLocation(project.location);
          const position = jitterCoords(base, project.id);
          return (
            <ProjectMapMarker
              key={project.id}
              project={project}
              position={[position.lat, position.lng]}
            />
          );
        })}
      </MapContainer>

      {tileError && (
        <div className="absolute inset-0 z-[1000] flex items-center justify-center bg-white/50 backdrop-blur-sm dark:bg-[#0A0A1A]/50">
          <div className="rounded-xl border border-gray-200 bg-white p-6 text-center shadow-xl dark:border-gray-800 dark:bg-[#0F172A]">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Map tiles unavailable
            </p>
            <p className="mt-2 max-w-xs text-xs text-gray-500 dark:text-gray-400">
              We couldn't load the map background, but project markers are still visible.
            </p>
            <button
              onClick={handleRetry}
              className="mt-4 rounded-lg bg-[#4F46E5] px-4 py-2 text-xs font-semibold text-white shadow-sm hover:bg-[#4338CA] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#4F46E5] dark:bg-[#4F46E5] dark:hover:bg-[#6366F1]"
            >
              Retry Connection
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
