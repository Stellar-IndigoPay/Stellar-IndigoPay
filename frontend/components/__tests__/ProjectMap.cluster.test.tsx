/**
 * __tests__/ProjectMap.cluster.test.tsx
 *
 * Tests for ProjectMap marker clustering (GrantFox #1130 / #1086). We exercise
 * the pure clustering helpers directly (exported from ProjectMap) with a
 * synthetic `L.Map`-shaped viewport so the assertions don't depend on a real
 * Leaflet canvas:
 *   - 200 projects spread across ~10 locations collapse to a handful of
 *     cluster badges at zoom 3 (not 200 individual markers).
 *   - Zooming into a single location fans the individual markers back out.
 */
import type L from "leaflet";
import type { ClimateProject } from "@/utils/types";

// react-leaflet is ESM and needs a real map container; we only exercise the
// pure clustering helpers, so stub it (and the CSS side-effect import) out.
jest.mock("react-leaflet", () => ({
  MapContainer: () => null,
  TileLayer: () => null,
  ZoomControl: () => null,
  Marker: () => null,
  useMap: () => ({}),
  useMapEvents: () => ({}),
}));
jest.mock("leaflet/dist/leaflet.css", () => ({}));

// Import AFTER the mocks so jest.mock applies.
// eslint-disable-next-line import/first
import { buildClusterIndex, computeClusters } from "../ProjectMap";

// supercluster + Leaflet are pure JS with no DOM dependency, so they run fine
// under jsdom. We don't render the MapContainer here — only the clustering
// math.

function makeProject(id: string, location: string): ClimateProject {
  return {
    id,
    name: `Project ${id}`,
    description: "Test project",
    category: "Reforestation",
    location,
    walletAddress: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNOPQRST",
    goalXLM: "10000",
    raisedXLM: "2500",
    donorCount: 10,
    co2OffsetKg: 100,
    status: "active",
    verified: true,
    onChainVerified: false,
    tags: [],
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  };
}

/** ~10 distinct world locations, spread out enough to form separate clusters. */
const LOCATIONS = [
  "Kenya",
  "Nigeria",
  "Brazil",
  "India",
  "Indonesia",
  "China",
  "United States",
  "Germany",
  "Australia",
  "Canada",
];

function makeTwoHundredProjects(): ClimateProject[] {
  const projects: ClimateProject[] = [];
  for (let i = 0; i < 200; i++) {
    projects.push(
      makeProject(`proj-${i}`, LOCATIONS[i % LOCATIONS.length]),
    );
  }
  return projects;
}

/** Minimal `L.Map`-shaped viewport covering the whole world at a given zoom. */
function makeViewport(zoom: number) {
  return {
    getBounds: () => ({
      getWest: () => -180,
      getSouth: () => -85,
      getEast: () => 180,
      getNorth: () => 85,
    }),
    getZoom: () => zoom,
  } as unknown as L.Map;
}

describe("ProjectMap clustering", () => {
  const projects = makeTwoHundredProjects();
  const index = buildClusterIndex(projects);

  it("collapses 200 markers into a small number of cluster badges at zoom 3", () => {
    const clusters = computeClusters(index, makeViewport(3));

    // Not 200 individual markers…
    expect(clusters.length).toBeLessThan(200);
    // …and close to the ~10 distinct locations.
    expect(clusters.length).toBeLessThanOrEqual(LOCATIONS.length * 2);

    // Every returned item is either a numbered cluster or a single point.
    const clusterCount = clusters.filter((c) => c.pointCount > 1).length;
    expect(clusterCount).toBeGreaterThan(0);

    // Total points accounted for across all clusters must equal 200.
    const totalPoints = clusters.reduce((sum, c) => sum + c.pointCount, 0);
    expect(totalPoints).toBe(projects.length);
  });

  it("fans individual markers back out when zoomed into a single location", () => {
    // A viewport centered on Kenya at a high zoom shows the 20 Kenya
    // projects as individual markers instead of one cluster badge. The
    // bounds are padded to cover the deterministic ±0.8° jitter applied to
    // each project coordinate.
    const kenyaViewport = {
      getBounds: () => ({
        getWest: () => 36.5,
        getSouth: () => -1.5,
        getEast: () => 39.5,
        getNorth: () => 1.5,
      }),
      getZoom: () => 10,
    } as unknown as L.Map;

    const clusters = computeClusters(index, kenyaViewport);

    const points = clusters.reduce((sum, c) => sum + c.pointCount, 0);
    // The 20 Kenya projects are visible and un-clustered at this zoom.
    expect(points).toBe(20);
    expect(clusters.every((c) => c.pointCount === 1)).toBe(true);
  });

  it("reports an expansion zoom greater than the current zoom for clusters", () => {
    const clusters = computeClusters(index, makeViewport(3));
    const multi = clusters.filter((c) => c.pointCount > 1);
    for (const cluster of multi) {
      expect(cluster.expansionZoom).toBeGreaterThan(3);
    }
  });
});
