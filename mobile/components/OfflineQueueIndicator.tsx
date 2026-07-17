/**
 * components/OfflineQueueIndicator.tsx
 *
 * Lightweight indicator that shows the number of items awaiting sync
 * in the offline queue. Tapping opens the donation queue detail sheet.
 *
 * Features:
 *   - Shows "N pending" badge when items are queued.
 *   - Subtle pulse animation while actively retrying.
 *   - Tapping navigates to the queue detail (reuses DonationQueueStatus
 *     internals or opens its own detail view).
 *
 * Usage:
 *   <OfflineQueueIndicator onPress={() => setQueueSheetVisible(true)} />
 */
import React, { useEffect, useRef, useState } from "react";
import {
  Animated,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useConnectivity } from "../lib/connectivity";
import { getPendingCount, getQueueSummary } from "../lib/offlineQueue";
import { useTheme } from "../app/theme";

const POLL_INTERVAL_MS = 10_000;

interface Props {
  onPress?: () => void;
}

export default function OfflineQueueIndicator({ onPress }: Props) {
  const { isOnline } = useConnectivity();
  const { colors } = useTheme();
  const [pendingCount, setPendingCount] = useState(0);
  const [failedCount, setFailedCount] = useState(0);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const isActive = useRef(false);

  // Poll queue state
  useEffect(() => {
    const refresh = async () => {
      try {
        const summary = await getQueueSummary();
        setPendingCount(summary.pending + summary.retrying);
        setFailedCount(summary.failed);
      } catch {
        // Ignore
      }
    };

    refresh();
    const interval = setInterval(refresh, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  // Pulse animation when items are being retried (online + pending)
  useEffect(() => {
    const hasPending = pendingCount > 0;

    if (hasPending && !isActive.current) {
      isActive.current = true;
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, {
            toValue: 0.6,
            duration: 800,
            useNativeDriver: true,
          }),
          Animated.timing(pulseAnim, {
            toValue: 1,
            duration: 800,
            useNativeDriver: true,
          }),
        ]),
      ).start();
    } else if (!hasPending && isActive.current) {
      isActive.current = false;
      pulseAnim.stopAnimation();
      pulseAnim.setValue(1);
    }
  }, [pendingCount, pulseAnim]);

  if (pendingCount === 0 && failedCount === 0) return null;

  return (
    <TouchableOpacity
      style={[
        styles.container,
        {
          backgroundColor: colors.surface + "F2",
          shadowColor: "#000",
        },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityLabel={`${pendingCount} item${pendingCount !== 1 ? "s" : ""} pending sync. ${failedCount} failed. Tap to view.`}
      accessibilityRole="button"
    >
      <Animated.View
        style={[
          styles.dot,
          {
            backgroundColor: failedCount > 0 ? "#ef4444" : "#f59e0b",
            transform: [{ scale: pendingCount > 0 ? pulseAnim : 1 }],
          },
        ]}
      />

      <View style={styles.textContainer}>
        {pendingCount > 0 && (
          <Text style={[styles.pendingText, { color: colors.primaryText }]}>
            {pendingCount} pending
          </Text>
        )}
        {failedCount > 0 && (
          <Text style={[styles.failedText, { color: "#ef4444" }]}>
            {failedCount} failed
          </Text>
        )}
      </View>

      {isOnline && pendingCount > 0 && (
        <Text style={[styles.syncingText, { color: colors.primary }]}>
          Syncing...
        </Text>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    position: "absolute",
    bottom: 80,
    right: 16,
    zIndex: 99,
    borderRadius: 20,
    paddingVertical: 8,
    paddingHorizontal: 14,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 5,
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  textContainer: {
    flexDirection: "row",
    gap: 6,
  },
  pendingText: {
    fontSize: 13,
    fontWeight: "700",
  },
  failedText: {
    fontSize: 13,
    fontWeight: "700",
  },
  syncingText: {
    fontSize: 11,
    fontWeight: "600",
  },
});
