/**
 * components/SyncStatusIcon.tsx
 *
 * Small icon that reflects the current sync / connectivity state.
 * Designed to be placed in header bars or next to data sections
 * (e.g. next to a project list heading).
 *
 * States:
 *   - synced (green check) — online and nothing pending.
 *   - syncing (blue spinning) — online, items being processed.
 *   - offline (red X) — no connectivity.
 *   - stale (amber warning) — showing cached data / has failed items.
 *
 * Usage:
 *   <SyncStatusIcon />
 */
import React from "react";
import { StyleSheet, Text, View } from "react-native";
import { useConnectivity } from "../lib/connectivity";
import { useTheme } from "../app/theme";

export type SyncStatus = "synced" | "syncing" | "offline" | "stale" | "unknown";

interface Props {
  /** Override the auto-detected status. */
  status?: SyncStatus;
  /** Pending count — if > 0 and online, shows "syncing". */
  pendingCount?: number;
  /** Show a text label next to the icon. */
  showLabel?: boolean;
  /** Size of the icon. Default: 14. */
  size?: number;
}

const STATUS_CONFIG: Record<
  SyncStatus,
  { icon: string; color: string; label: string }
> = {
  synced: { icon: "✓", color: "#22c55e", label: "Synced" },
  syncing: { icon: "↻", color: "#3b82f6", label: "Syncing…" },
  offline: { icon: "✕", color: "#ef4444", label: "Offline" },
  stale: { icon: "!", color: "#f59e0b", label: "Cached" },
  unknown: { icon: "?", color: "#9ca3af", label: "Unknown" },
};

export default function SyncStatusIcon({
  status: statusProp,
  pendingCount = 0,
  showLabel = false,
  size = 14,
}: Props) {
  const { isOnline } = useConnectivity();

  const resolvedStatus: SyncStatus =
    statusProp ??
    (() => {
      if (!isOnline) return "offline";
      if (pendingCount > 0) return "syncing";
      return "synced";
    })();

  const config = STATUS_CONFIG[resolvedStatus];

  return (
    <View style={styles.container}>
      <View
        style={[
          styles.iconCircle,
          {
            width: size + 8,
            height: size + 8,
            borderRadius: (size + 8) / 2,
            backgroundColor: config.color + "18",
          },
        ]}
      >
        <Text
          style={[
            styles.icon,
            {
              fontSize: size,
              color: config.color,
            },
          ]}
        >
          {config.icon}
        </Text>
      </View>
      {showLabel && (
        <Text
          style={[
            styles.label,
            {
              color: config.color,
              fontSize: size - 2,
            },
          ]}
        >
          {config.label}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  iconCircle: {
    alignItems: "center",
    justifyContent: "center",
  },
  icon: {
    fontWeight: "800",
  },
  label: {
    fontWeight: "600",
  },
});
