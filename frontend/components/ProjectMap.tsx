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
 * Performance (GrantFox #1130 / #1086):
 *   - Markers are clustered with `supercluster`: nearby projects merge into a
 *     single numbered badge at low zoom levels, so 200 projects render as
 *     ~10 cluster badges at zoom 3 instead of 200 individual DOM nodes.
 *     Zooming into a cluster fans the individual markers out.
 *   - The cluster index is built once per `projects` change (memoised), and
 *     the visible marker set is recomputed only on map move/zoom events.
 *   - Tiles are loaded lazily: `keepBuffer={0}` means only tiles inside the
 *     viewport are fetched, and `updateWhenIdle` defers tile requests until
 *     pan/zoom settles, cutting request volume during fast navigation.
 *
 * Tile provider: OpenStreetMap (no API key required, free to use under ODbL).
 * Marker icons: each ProjectMapMarker renders its own accessible DivIcon
 * (inline SVG wrapped in a focusable <button>) so we don't depend on
 * Leaflet's image assets, which break under webpack/Next.js bundling.
 * Cluster badges use the same pattern (a focusable, labelled <button>).
 */
"use client";

import { useCallback, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  TileLayer,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import Supercluster from "supercluster";
import type { ClimateProject } from "@/utils/types";
import { geocodeLocation, jitterCoords } from "@/utils/geocode";
import ProjectMapMarker from "./ProjectMapMarker";

import "leaflet/dist/leaflet.css";

// ── Types ──────────────────────────────────────────────────────────────────────

interface ProjectMapProps {
  /** Active climate projects to pin on the map. */
  projects: ClimateProject[];
}

/** Properties attached to every input point in the supercluster index. */
interface ProjectPointProperties {
  project: ClimateProject;
}

/** Shorthand for a supercluster input feature carrying a project. */
type ProjectPoint = Supercluster.PointFeature<ProjectPointProperties>;

/** A cluster feature returned by supercluster for the current viewport. */
type ProjectCluster = Supercluster.ClusterFeature<Record<string, never>>;

/** A resolved cluster or single project visible in the current viewport. */
interface ClusterView {
  id: string;
  lat: number;
  lng: number;
  pointCount: number;
  expansionZoom: number;
}

// ── Cluster index ─────────────────────────────────────────────────────────────

/** Pixel radius within which points merge into a cluster. */
const CLUSTER_RADIUS = 60;
/** Never cluster markers beyond this zoom level. */
const CLUSTER_MAX_ZOOM = 16;

/**
 * Build a supercluster index from the project list. Each project's location
 * is geocoded and deterministically jittered (so stacked markers stay
 * individually clickable) before being loaded into the index.
 */
export function buildClusterIndex(
  projects: ClimateProject[],
): Supercluster<ProjectPointProperties> {
  const index = new Supercluster<ProjectPointProperties>({
    radius: CLUSTER_RADIUS,
    maxZoom: CLUSTER_MAX_ZOOM,
  });
  index.load(
    projects.map((project) => {
      const base = geocodeLocation(project.location);
      const position = jitterCoords(base, project.id);
      return {
        type: "Feature",
        id: project.id,
        geometry: {
          type: "Point",
          coordinates: [position.lng, position.lat] as [number, number],
        },
        properties: { project },
      };
    }),
  );
  return index;
}

/**
 * Query the index for everything inside the current map viewport at the
 * current zoom and normalise it into `ClusterView` items.
 */
export function computeClusters(
  index: Supercluster<ProjectPointProperties>,
  map: L.Map,
): ClusterView[] {
  const bounds = map.getBounds();
  const zoom = map.getZoom();
  const bbox: [number, number, number, number] = [
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast(),
    bounds.getNorth(),
  ];

  return index.getClusters(bbox, zoom).map((feature) => {
    const [lng, lat] = feature.geometry.coordinates;
    const properties = feature.properties as
      | ProjectPointProperties
      | (Supercluster.ClusterProperties & Record<string, never>);

    if (
      "cluster" in properties &&
      properties.cluster === true &&
      typeof properties.cluster_id === "number"
    ) {
      return {
        id: `cluster-${properties.cluster_id}`,
        lat,
        lng,
        pointCount: properties.point_count,
        expansionZoom: index.getClusterExpansionZoom(properties.cluster_id),
      };
    }
    return {
      id: String(feature.id),
      lat,
      lng,
      pointCount: 1,
      expansionZoom: zoom,
    };
  });
}

// ── Cluster badge icon ─────────────────────────────────────────────────────────

/**
 * Escape HTML special characters so the count is safe to embed in the
 * divIcon HTML.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build an accessible Leaflet DivIcon for a numbered cluster badge. The icon
 * HTML is a focusable <button> (mirroring ProjectMapMarker) so keyboard and
 * screen-reader users can activate the cluster zoom.
 */
function buildClusterIcon(pointCount: number): L.DivIcon {
  const safeCount = escapeHtml(String(pointCount));
  return L.divIcon({
    className: "indigopay-cluster",
    html: `
      <button
        type="button"
        class="indigopay-cluster-btn"
        tabindex="0"
        role="button"
        aria-label="${safeCount} projects in this cluster. Zoom in to see them."
        title="${safeCount} projects — zoom in to see them"
      >${safeCount}</button>
    `,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}

// ── Cluster layer (child of MapContainer) ──────────────────────────────────────

/**
 * Renders the clustered markers for the current viewport. Lives inside the
 * MapContainer so it can read the map instance via `useMap()` and refresh the
 * visible cluster set on every move/zoom.
 */
function ClusterLayer({ projects }: { projects: ClimateProject[] }) {
  const map = useMap();
  const index = useMemo(() => buildClusterIndex(projects), [projects]);
  const projectsById = useMemo(
    () => new Map(projects.map((project) => [project.id, project])),
    [projects],
  );

  const [clusters, setClusters] = useState<ClusterView[]>(() =>
    computeClusters(index, map),
  );

  const refresh = useCallback(() => {
    setClusters(computeClusters(index, map));
  }, [index, map]);

  // Recompute the visible markers whenever the map moves, zooms, or the
  // project list changes.
  useMapEvents({
    moveend: refresh,
    zoomend: refresh,
  });

  const handleClusterZoom = useCallback(
    (cluster: ClusterView) => {
      map.flyTo([cluster.lat, cluster.lng], cluster.expansionZoom, {
        duration: 0.5,
      });
    },
    [map],
  );

  const clusterIconCache = useMemo(() => new Map<number, L.DivIcon>(), []);

  return (
    <>
      {clusters.map((cluster) => {
        if (cluster.pointCount === 1) {
          const project = projectsById.get(cluster.id);
          if (!project) return null;
          return (
            <ProjectMapMarker
              key={cluster.id}
              project={project}
              position={[cluster.lat, cluster.lng]}
            />
          );
        }

        let icon = clusterIconCache.get(cluster.pointCount);
        if (!icon) {
          icon = buildClusterIcon(cluster.pointCount);
          clusterIconCache.set(cluster.pointCount, icon);
        }

        return (
          <Marker
            key={cluster.id}
            position={[cluster.lat, cluster.lng]}
            icon={icon}
            eventHandlers={{
              click: () => handleClusterZoom(cluster),
              keydown: (event: L.LeafletEvent) => {
                const originalEvent = (
                  event as L.LeafletKeyboardEvent
                ).originalEvent as KeyboardEvent | undefined;
                if (!originalEvent) return;
                if (originalEvent.key === "Enter" || originalEvent.key === " ") {
                  originalEvent.preventDefault();
                  handleClusterZoom(cluster);
                }
              },
            }}
          />
        );
      })}
    </>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function ProjectMap({ projects }: ProjectMapProps) {
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
      {/* OpenStreetMap tile layer — no API key needed. `keepBuffer={0}`
          restricts tile fetches to the viewport and `updateWhenIdle` defers
          them until pan/zoom settles (lazy tile loading). */}
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
        maxZoom={19}
        keepBuffer={0}
        updateWhenIdle
      />

      {/* Custom positioned zoom control (bottom-right avoids navbar overlap) */}
      <ZoomControl position="bottomright" />

      {/* Clustered project markers */}
      <ClusterLayer projects={projects} />
    </MapContainer>
  );
}
