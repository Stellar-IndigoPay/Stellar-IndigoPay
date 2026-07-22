/**
 * components/WorldMap.tsx
 *
 * Enhanced world map that displays project regions and real-time donation
 * markers. When new donations arrive via Socket.IO, animated markers pulse
 * at the project's coordinates for 3 seconds then fade away.
 */
import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";
import type { ClimateProject } from "@/utils/types";

/**
 * A single donation event with enough info to place a marker on the map.
 */
export interface DonationMapItem {
  id: string;
  projectId: string;
  projectName: string;
  amountXLM: string;
  /** Approximate coordinates for the marker. */
  lat?: number;
  lng?: number;
  createdAt: string;
}

interface WorldMapProps {
  /** Projects to show as static markers on the map. */
  projects?: ClimateProject[];
  /** Live donation events to display as animated markers. */
  donations?: DonationMapItem[];
  /** Map projectId to approximate coordinates. */
  projectCoordinates?: Record<string, { lat: number; lng: number }>;
}

// Default project region coordinates (hardcoded for the SVG map)
const DEFAULT_REGIONS: Array<{
  cx: number;
  cy: number;
  name: string;
  projectId?: string;
}> = [
  { cx: 220, cy: 120, name: "North America" },
  { cx: 280, cy: 260, name: "South America" },
  { cx: 480, cy: 110, name: "Europe" },
  { cx: 520, cy: 220, name: "Africa" },
  { cx: 680, cy: 140, name: "Asia" },
  { cx: 800, cy: 280, name: "Australia" },
  { cx: 720, cy: 200, name: "Southeast Asia" },
];

/**
 * Shared region coordinates keyed by region name so project coordinates
 * can be mapped deterministically for the SVG.
 */
const REGION_COORDS: Record<string, { cx: number; cy: number }> = {
  "North America": { cx: 220, cy: 120 },
  "South America": { cx: 280, cy: 260 },
  Europe: { cx: 480, cy: 110 },
  Africa: { cx: 520, cy: 220 },
  Asia: { cx: 680, cy: 140 },
  Australia: { cx: 800, cy: 280 },
  "Southeast Asia": { cx: 720, cy: 200 },
  // Generic fallbacks for unlisted locations
  default: { cx: 500, cy: 200 },
};

/**
 * Best-effort mapping from a location string to SVG coordinates.
 * Parses common patterns like "City, Country" or standalone country names.
 */
function locationToCoords(
  location: string,
): { cx: number; cy: number } {
  const loc = location.toLowerCase();

  // Americas
  if (loc.includes("united states") || loc.includes("canada") || loc.includes("mexico") || loc.includes("north america"))
    return REGION_COORDS["North America"];
  if (loc.includes("brazil") || loc.includes("argentina") || loc.includes("chile") || loc.includes("colombia") || loc.includes("peru") || loc.includes("south america"))
    return REGION_COORDS["South America"];

  // Europe
  if (loc.includes("germany") || loc.includes("france") || loc.includes("uk") || loc.includes("united kingdom") || loc.includes("spain") || loc.includes("italy") || loc.includes("netherlands") || loc.includes("sweden") || loc.includes("europe"))
    return REGION_COORDS.Europe;

  // Africa
  if (loc.includes("kenya") || loc.includes("nigeria") || loc.includes("south africa") || loc.includes("ghana") || loc.includes("ethiopia") || loc.includes("tanzania") || loc.includes("africa"))
    return REGION_COORDS.Africa;

  // Asia
  if (loc.includes("india") || loc.includes("china") || loc.includes("japan") || loc.includes("nepal") || loc.includes("bangladesh") || loc.includes("asia"))
    return REGION_COORDS.Asia;

  // Australia / Oceania
  if (loc.includes("australia") || loc.includes("new zealand") || loc.includes("fiji"))
    return REGION_COORDS.Australia;

  // Southeast Asia
  if (loc.includes("indonesia") || loc.includes("philippines") || loc.includes("thailand") || loc.includes("vietnam") || loc.includes("malaysia"))
    return REGION_COORDS["Southeast Asia"];

  return REGION_COORDS.default;
}

/**
 * Get SVG coordinates for a project based on its location or category.
 */
function projectCoords(project: ClimateProject): { cx: number; cy: number } {
  if (project.location) return locationToCoords(project.location);
  // Fallback: map by category
  const cat = project.category.toLowerCase();
  if (cat.includes("forest") || cat.includes("reforestation")) return REGION_COORDS["North America"];
  if (cat.includes("solar")) return REGION_COORDS.Africa;
  if (cat.includes("ocean")) return REGION_COORDS.Australia;
  if (cat.includes("wildlife")) return REGION_COORDS["South America"];
  if (cat.includes("carbon")) return REGION_COORDS.Asia;
  return REGION_COORDS.default;
}

export default function WorldMap({
  projects,
  donations = [],
  projectCoordinates,
}: WorldMapProps) {
  // Track active donation marker IDs for deduplication (avoids stale closure over state)
  const activeMarkerIdsRef = useRef<Set<string>>(new Set());

  // Track active donation markers with their animation state
  const [activeDonationMarkers, setActiveDonationMarkers] = useState<
    Array<{
      id: string;
      cx: number;
      cy: number;
      projectName: string;
      amountXLM: string;
      timestamp: number;
    }>
  >([]);

  // Process donation items into animated markers
  useEffect(() => {
    if (donations.length === 0) return;

    const newMarkers = donations
      .map((d) => {
        // Try to find coordinates from projectCoordinates or projects
        let cx = 500;
        let cy = 200;

        if (projectCoordinates && projectCoordinates[d.projectId]) {
          const coord = projectCoordinates[d.projectId];
          // Approximate conversion from lat/lng to SVG coords
          cx = ((coord.lng + 180) / 360) * 900 + 50;
          cy = ((90 - coord.lat) / 180) * 400 + 50;
        } else if (projects) {
          const project = projects.find((p) => p.id === d.projectId);
          if (project) {
            const coords = projectCoords(project);
            cx = coords.cx;
            cy = coords.cy;
          }
        }

        return {
          id: d.id,
          cx,
          cy,
          projectName: d.projectName,
          amountXLM: d.amountXLM,
          timestamp: Date.now(),
        };
      })
      .filter((m) => !activeMarkerIdsRef.current.has(m.id));

    if (newMarkers.length === 0) return;
    newMarkers.forEach((m) => activeMarkerIdsRef.current.add(m.id));
    setActiveDonationMarkers((prev) => [...newMarkers, ...prev].slice(0, 20));

    // Remove markers older than 3 seconds
    const cleanupTimer = setTimeout(() => {
      setActiveDonationMarkers((prev) =>
        prev.filter((m) => {
          if (Date.now() - m.timestamp < 3000) return true;
          activeMarkerIdsRef.current.delete(m.id);
          return false;
        }),
      );
    }, 3000);

    return () => clearTimeout(cleanupTimer);
  }, [donations, projectCoordinates, projects]);

  // Merge project markers and region markers
  const regionMarkers = useMemo(() => {
    if (projects && projects.length > 0) {
      return projects.map((p) => ({
        cx: projectCoords(p).cx,
        cy: projectCoords(p).cy,
        name: p.name,
        projectId: p.id,
      }));
    }
    return DEFAULT_REGIONS;
  }, [projects]);

  const [selectedMarker, setSelectedMarker] = useState<{
    name: string;
    amount?: string;
    cx: number;
    cy: number;
  } | null>(null);

  // Clean up marker dismiss timeout on unmount
  const markerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (markerTimerRef.current) clearTimeout(markerTimerRef.current);
    };
  }, []);

  const handleMarkerClick = useCallback(
    (marker: { name: string; cx: number; cy: number; amount?: string }) => {
      setSelectedMarker(marker);
      if (markerTimerRef.current) clearTimeout(markerTimerRef.current);
      markerTimerRef.current = setTimeout(() => {
        setSelectedMarker(null);
        markerTimerRef.current = null;
      }, 4000);
    },
    [],
  );

  return (
    <div className="w-full flex flex-col items-center py-4 relative group">
      <p className="text-sm text-[#4F46E5] dark:text-[#818CF8] mb-4 font-medium">
        {donations.length > 0
          ? "Live donation activity"
          : "Active project regions"}
      </p>

      <div className="relative w-full max-w-4xl">
        <svg
          viewBox="0 0 1000 500"
          className="w-full drop-shadow-md"
          fill="none"
          stroke="currentColor"
        >
          {/* Simple stylized world map paths */}
          {/* North America */}
          <path
            d="M 120 100 Q 150 40 250 80 T 300 150 T 250 200 T 150 180 Z"
            fill="#D4D8FF"
            stroke="#818CF8"
            strokeWidth="2"
            className="transition-colors hover:fill-[#C7D2FE] dark:fill-[#2D28A3]/30 dark:hover:fill-[#3730A3]/40"
          />
          {/* South America */}
          <path
            d="M 230 200 Q 300 200 320 280 Q 300 400 280 420 Q 250 350 220 250 Z"
            fill="#D4D8FF"
            stroke="#818CF8"
            strokeWidth="2"
            className="transition-colors hover:fill-[#C7D2FE] dark:fill-[#2D28A3]/30 dark:hover:fill-[#3730A3]/40"
          />
          {/* Europe */}
          <path
            d="M 400 80 Q 480 50 520 80 T 500 150 Q 450 160 420 140 Z"
            fill="#D4D8FF"
            stroke="#818CF8"
            strokeWidth="2"
            className="transition-colors hover:fill-[#C7D2FE] dark:fill-[#2D28A3]/30 dark:hover:fill-[#3730A3]/40"
          />
          {/* Africa */}
          <path
            d="M 440 160 Q 550 150 580 220 Q 550 350 520 360 Q 480 300 460 250 Z"
            fill="#D4D8FF"
            stroke="#818CF8"
            strokeWidth="2"
            className="transition-colors hover:fill-[#C7D2FE] dark:fill-[#2D28A3]/30 dark:hover:fill-[#3730A3]/40"
          />
          {/* Asia */}
          <path
            d="M 500 80 Q 600 40 750 60 T 800 150 Q 750 220 650 200 Q 550 180 520 120 Z"
            fill="#D4D8FF"
            stroke="#818CF8"
            strokeWidth="2"
            className="transition-colors hover:fill-[#C7D2FE] dark:fill-[#2D28A3]/30 dark:hover:fill-[#3730A3]/40"
          />
          {/* Australia */}
          <path
            d="M 750 250 Q 820 230 850 280 Q 820 330 780 320 Z"
            fill="#D4D8FF"
            stroke="#818CF8"
            strokeWidth="2"
            className="transition-colors hover:fill-[#C7D2FE] dark:fill-[#2D28A3]/30 dark:hover:fill-[#3730A3]/40"
          />

          {/* Static project/region markers */}
          {regionMarkers.map((loc, i) => (
            <g
              key={`region-${i}`}
              className="cursor-pointer"
              onClick={() => handleMarkerClick(loc)}
              role="button"
              aria-label={`Project region: ${loc.name}`}
              tabIndex={0}
            >
              <circle
                cx={loc.cx}
                cy={loc.cy}
                r="16"
                fill="#4F46E5"
                className="opacity-20 animate-ping"
              />
              <circle
                cx={loc.cx}
                cy={loc.cy}
                r="6"
                fill="#4F46E5"
                className="shadow-lg"
              />
              <text
                x={loc.cx}
                y={loc.cy - 15}
                className="text-xs fill-[#4338CA] dark:fill-[#C7D2FE] font-bold opacity-0 transition-opacity duration-300"
                textAnchor="middle"
              >
                {loc.name}
              </text>
            </g>
          ))}

          {/* Animated donation markers */}
          {activeDonationMarkers.map((marker) => (
            <g
              key={marker.id}
              className="donation-marker"
              onClick={() =>
                handleMarkerClick({
                  name: marker.projectName,
                  amount: marker.amountXLM,
                  cx: marker.cx,
                  cy: marker.cy,
                })
              }
              role="button"
              aria-label={`Donation to ${marker.projectName}: ${marker.amountXLM} XLM`}
              tabIndex={0}
            >
              {/* Outer pulse ring */}
              <circle
                cx={marker.cx}
                cy={marker.cy}
                r="24"
                fill="none"
                stroke="#10B981"
                strokeWidth="2"
                className="donation-pulse-ring"
              />
              {/* Inner glow */}
              <circle
                cx={marker.cx}
                cy={marker.cy}
                r="10"
                fill="rgba(16,185,129,0.3)"
                className="donation-glow"
              />
              {/* Core dot */}
              <circle
                cx={marker.cx}
                cy={marker.cy}
                r="5"
                fill="#10B981"
                className="donation-core"
              />
              {/* Amount label */}
              <text
                x={marker.cx}
                y={marker.cy - 28}
                className="text-[10px] fill-emerald-600 dark:fill-emerald-400 font-bold donation-label"
                textAnchor="middle"
              >
                +{parseFloat(marker.amountXLM).toFixed(1)} XLM
              </text>
            </g>
          ))}

          {/* Tooltip for selected marker */}
          {selectedMarker && (
            <g>
              <rect
                x={selectedMarker.cx - 60}
                y={selectedMarker.cy - 60}
                width="120"
                height="36"
                rx="6"
                fill="#0F172A"
                opacity="0.9"
              />
              <text
                x={selectedMarker.cx}
                y={selectedMarker.cy - 44}
                className="text-[10px] fill-white font-medium"
                textAnchor="middle"
              >
                {selectedMarker.name}
              </text>
              {selectedMarker.amount && (
                <text
                  x={selectedMarker.cx}
                  y={selectedMarker.cy - 32}
                  className="text-[9px] fill-emerald-400"
                  textAnchor="middle"
                >
                  {parseFloat(selectedMarker.amount).toFixed(2)} XLM
                </text>
              )}
            </g>
          )}
        </svg>

        {/* Legend */}
        <div className="absolute bottom-2 right-2 flex items-center gap-4 text-[11px] text-[#64748B] dark:text-[#94A3B8] bg-white/80 dark:bg-[#0A0A1A]/80 backdrop-blur-sm rounded-lg px-3 py-1.5 border border-[rgba(99,102,241,0.10)] dark:border-[rgba(129,140,248,0.12)]">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-[#4F46E5]" />
            Projects
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            Live donation
          </span>
        </div>
      </div>

      <style>{`
        g:hover text:first-of-type {
          opacity: 1;
        }

        @keyframes donationPulse {
          0% {
            r: 24;
            opacity: 0.6;
          }
          50% {
            opacity: 0.3;
          }
          100% {
            r: 40;
            opacity: 0;
          }
        }

        @keyframes donationGlow {
          0%, 100% {
            opacity: 0.6;
            r: 10;
          }
          50% {
            opacity: 1;
            r: 12;
          }
        }

        @keyframes donationFade {
          0% {
            opacity: 1;
          }
          70% {
            opacity: 1;
          }
          100% {
            opacity: 0;
          }
        }

        .donation-pulse-ring {
          animation: donationPulse 1.5s ease-out infinite;
        }

        .donation-glow {
          animation: donationGlow 1.5s ease-in-out infinite;
        }

        .donation-core {
          animation: donationFade 3s ease-out forwards;
        }

        .donation-label {
          animation: donationFade 3s ease-out forwards;
        }
      `}</style>
    </div>
  );
}

export { locationToCoords, REGION_COORDS };
