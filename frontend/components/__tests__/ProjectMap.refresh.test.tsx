/**
 * __tests__/ProjectMap.refresh.test.tsx
 *
 * Regression test for the CodeRabbit review on #1178: when the `projects`
 * prop changes, the cluster index is rebuilt but the visible cluster viewport
 * must also be recomputed — otherwise the map keeps showing stale markers
 * until the user pans or zooms.
 *
 * We render the real ProjectMap/ClusterLayer with a stubbed react-leaflet
 * (fake map + captured event handlers) so the move/zoom handlers, the
 * project-change effect, and the marker rendering are all exercised.
 */
import { render, screen, act } from "@testing-library/react";
import type L from "leaflet";
import type { ClimateProject } from "@/utils/types";

// ── Stub react-leaflet ────────────────────────────────────────────────────────
// useMap returns a fake Leaflet map; useMapEvents records the handlers so the
// test can fire moveend/zoomend; Marker renders a testable node that exposes
// whether it is a cluster badge and its count.
const fakeMap: {
  getBounds: () => {
    getWest: () => number;
    getSouth: () => number;
    getEast: () => number;
    getNorth: () => number;
  };
  getZoom: () => number;
  flyTo: jest.Mock;
} = {
  getBounds: () => ({
    getWest: () => -180,
    getSouth: () => -85,
    getEast: () => 180,
    getNorth: () => 85,
  }),
  getZoom: () => 3,
  flyTo: jest.fn(),
};

let capturedHandlers: Record<string, () => void> = {};

jest.mock("react-leaflet", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = jest.requireActual("react");
  const Marker = ({
    icon,
    children,
  }: {
    icon?: { options?: { html?: string } };
    children?: React.ReactNode;
  }) => {
    const html = icon?.options?.html ?? "";
    const isCluster = html.includes("indigopay-cluster-btn");
    const countMatch = html.match(/aria-label="(\d+) projects/);
    return (
      <div
        data-testid="map-marker"
        data-cluster={isCluster ? "true" : "false"}
        data-count={countMatch ? countMatch[1] : "1"}
      >
        {children}
      </div>
    );
  };
  Marker.displayName = "LeafletMarkerStub";
  return {
    MapContainer: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="map-container">{children}</div>
    ),
    TileLayer: () => null,
    ZoomControl: () => null,
    Marker,
    Popup: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="popup">{children}</div>
    ),
    useMap: () => fakeMap,
    useMapEvents: (handlers: Record<string, () => void>) => {
      capturedHandlers = handlers;
    },
  };
});

jest.mock("leaflet/dist/leaflet.css", () => ({}));

// eslint-disable-next-line import/first
import ProjectMap from "../ProjectMap";

// ── Fixtures ──────────────────────────────────────────────────────────────────

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

function countClusterMarkers(): number {
  return screen
    .getAllByTestId("map-marker")
    .filter((el) => el.getAttribute("data-cluster") === "true").length;
}

function countTotalPoints(): number {
  return screen
    .getAllByTestId("map-marker")
    .reduce(
      (sum, el) => sum + Number(el.getAttribute("data-count") ?? "1"),
      0,
    );
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("ProjectMap project-prop refresh", () => {
  beforeEach(() => {
    capturedHandlers = {};
    fakeMap.flyTo.mockClear();
  });

  it("re-clusters automatically when the projects prop changes (no pan/zoom needed)", () => {
    // 10 projects in the same location → one cluster badge of 10.
    const firstBatch = Array.from({ length: 10 }, (_, i) =>
      makeProject(`proj-${i}`, "Kenya"),
    );
    const { rerender } = render(<ProjectMap projects={firstBatch} />);

    expect(countClusterMarkers()).toBe(1);
    expect(countTotalPoints()).toBe(10);

    // 20 projects in the same location → the cluster count must update
    // purely from the prop change.
    const secondBatch = Array.from({ length: 20 }, (_, i) =>
      makeProject(`proj-${i}`, "Kenya"),
    );
    rerender(<ProjectMap projects={secondBatch} />);

    expect(countClusterMarkers()).toBe(1);
    expect(countTotalPoints()).toBe(20);
  });

  it("fans markers back out after zooming in (move/zoom handler wired)", () => {
    const projects = Array.from({ length: 5 }, (_, i) =>
      makeProject(`proj-${i}`, "Nigeria"),
    );
    render(<ProjectMap projects={projects} />);

    expect(countClusterMarkers()).toBe(1);

    // Zoom in hard: the fake map now reports zoom 16, and the zoomend
    // handler recomputes the visible clusters → 5 individual markers. The
    // viewport covers the full ±0.8° jitter box around Nigeria.
    fakeMap.getZoom = () => 16;
    fakeMap.getBounds = () => ({
      getWest: () => 7.5,
      getSouth: () => 8.0,
      getEast: () => 9.8,
      getNorth: () => 10.0,
    });

    act(() => {
      capturedHandlers.zoomend();
    });

    expect(countClusterMarkers()).toBe(0);
    expect(countTotalPoints()).toBe(5);
    expect(
      screen.getAllByTestId("map-marker").every((el) => el.getAttribute("data-cluster") === "false"),
    ).toBe(true);
  });
});
