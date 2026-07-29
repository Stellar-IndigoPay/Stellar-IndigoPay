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

import { useEffect } from "react";
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

export default function ProjectMap({ projects }: ProjectMapProps) {
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
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
        maxZoom={19}
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
  );
}
