/**
 * components/ProjectMap.tsx
 *
 * A full-viewport Leaflet world map that renders active climate project
 * markers. Nearby project markers are grouped into cluster markers when zoomed out.
 *
 * ⚠ Leaflet has no server-side rendering support — this component MUST be
 *   imported with `{ ssr: false }` via next/dynamic:
 *
 *   ```ts
 *   const ProjectMap = dynamic(() => import('@/components/ProjectMap'), { ssr: false });
 *   ```
 *
 * Tile provider: OpenStreetMap (no API key required, free to use under ODbL).
 * Icons: Leaflet's built-in SVG divIcon so we avoid broken default-icon paths.
 */
"use client";

import { useEffect, useState, useTransition } from "react";
import { MapContainer, TileLayer, ZoomControl, Marker, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import type { ClimateProject } from "@/utils/types";
import { geocodeLocation, jitterCoords } from "@/utils/geocode";
import ProjectMapMarker from "./ProjectMapMarker";

// ── Fix Leaflet's broken default-icon asset resolution under webpack ───────────
const DEFAULT_ICON = L.divIcon({
  className: "",
  html: `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 36" width="24" height="36" aria-hidden="true">
      <path
        d="M12 0C5.373 0 0 5.373 0 12c0 8.5 12 24 12 24S24 20.5 24 12C24 5.373 18.627 0 12 0z"
        fill="#4F46E5"
        stroke="#ffffff"
        stroke-width="1.5"
      />
      <circle cx="12" cy="12" r="5" fill="#ffffff" opacity="0.9"/>
    </svg>
  `,
  iconSize: [24, 36],
  iconAnchor: [12, 36],
  popupAnchor: [0, -38],
});

L.Marker.prototype.options.icon = DEFAULT_ICON;

// ── Types ──────────────────────────────────────────────────────────────────────

interface ProjectMapProps {
  /** Active climate projects to pin on the map. */
  projects: ClimateProject[];
}

interface ClusterData {
  id: string;
  lat: number;
  lng: number;
  projects: ClimateProject[];
  bounds: [number, number][];
}

// ── Clustering Helper Component ───────────────────────────────────────────────

function ProjectClusters({ projects }: { projects: ClimateProject[] }) {
  const map = useMap();
  const [clusters, setClusters] = useState<ClusterData[]>([]);
  const [, startTransition] = useTransition();

  const updateClusters = () => {
    const currentZoom = map.getZoom();
    const clusterRadius = 60; // pixels

    // Project each project's geocoded location to pixel space at current zoom
    const projectedPoints = projects.map((project) => {
      const base = geocodeLocation(project.location);
      const coords = jitterCoords(base, project.id);
      const pixel = map.project([coords.lat, coords.lng], currentZoom);
      return {
        project,
        lat: coords.lat,
        lng: coords.lng,
        x: pixel.x,
        y: pixel.y,
      };
    });

    const newClusters: ClusterData[] = [];

    for (const point of projectedPoints) {
      let merged = false;
      for (const cluster of newClusters) {
        // Project cluster's current average center to pixel space
        const clusterPixel = map.project([cluster.lat, cluster.lng], currentZoom);
        const dx = point.x - clusterPixel.x;
        const dy = point.y - clusterPixel.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < clusterRadius) {
          cluster.projects.push(point.project);
          cluster.bounds.push([point.lat, point.lng]);
          
          // Re-compute average center of cluster
          const count = cluster.projects.length;
          cluster.lat = (cluster.lat * (count - 1) + point.lat) / count;
          cluster.lng = (cluster.lng * (count - 1) + point.lng) / count;
          merged = true;
          break;
        }
      }

      if (!merged) {
        newClusters.push({
          id: `cluster-${point.project.id}`,
          lat: point.lat,
          lng: point.lng,
          projects: [point.project],
          bounds: [[point.lat, point.lng]],
        });
      }
    }

    startTransition(() => {
      setClusters(newClusters);
    });
  };

  // Run on map events
  useMapEvents({
    zoomend: updateClusters,
    moveend: updateClusters,
  });

  // Run when projects change or on map load
  useEffect(() => {
    updateClusters();
  }, [projects, map]);

  return (
    <>
      {clusters.map((cluster) => {
        if (cluster.projects.length === 1) {
          const project = cluster.projects[0];
          return (
            <ProjectMapMarker
              key={project.id}
              project={project}
              position={[cluster.lat, cluster.lng]}
            />
          );
        }

        // Render multi-project cluster marker
        const count = cluster.projects.length;
        const size = count < 10 ? 40 : count < 50 ? 48 : 56;
        
        const clusterIcon = L.divIcon({
          html: `
            <div class="flex items-center justify-center w-full h-full rounded-full text-white font-semibold font-display shadow-lg border-2 border-white transition-transform hover:scale-105 duration-200"
                 style="background: linear-gradient(135deg, #4F46E5, #7C3AED)">
              <span class="text-xs">${count}</span>
            </div>
          `,
          className: "",
          iconSize: [size, size],
          iconAnchor: [size / 2, size / 2],
        });

        const handleClusterClick = () => {
          const bounds = L.latLngBounds(cluster.bounds);
          map.fitBounds(bounds, { maxZoom: Math.min(map.getZoom() + 2, 18), animate: true });
        };

        return (
          <Marker
            key={cluster.id}
            position={[cluster.lat, cluster.lng]}
            icon={clusterIcon}
            eventHandlers={{
              click: handleClusterClick,
            }}
          />
        );
      })}
    </>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ProjectMap({ projects }: ProjectMapProps) {
  useEffect(() => {
    if (
      typeof document !== "undefined" &&
      !document.head.querySelector('link[href*="leaflet"]')
    ) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
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
      maxBounds={[
        [-90, -180],
        [90, 180],
      ]}
      maxBoundsViscosity={1.0}
      aria-label="World map of active climate projects"
    >
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
        maxZoom={19}
      />

      <ZoomControl position="bottomright" />

      {/* Render clustering component */}
      <ProjectClusters projects={projects} />
    </MapContainer>
  );
}
