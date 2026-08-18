/**
 * components/ConnectivityBanner.tsx
 *
 * Persistent banner that appears when the device loses connectivity and
 * disappears when connectivity is restored.
 *
 * Features:
 *   - Animated slide-in/out (fade + translate).
 *   - Shows "You are offline" with a Wi-Fi-off icon when disconnected.
 *   - Shows "Back online" briefly on reconnect.
 *   - Non-blocking — renders as an absolute-positioned overlay so it
 *     doesn't shift the layout.
 *   - Auto-dismisses the "Back online" toast after 3 seconds.
 *
 * Usage:
 *   // In _layout.tsx (recommended — single instance for the whole app).
 *   <ConnectivityBanner />
 */
import React, { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectivity } from "../lib/connectivity";

const BACK_ONLINE_DURATION_MS = 3000;
const ANIMATION_DURATION_MS = 300;

export default function ConnectivityBanner() {
  const { isOnline } = useConnectivity();
  const insets = useSafeAreaInsets();
  const [visible, setVisible] = useState(false);
  const [showBackOnline, setShowBackOnline] = useState(false);
  const translateY = useRef(new Animated.Value(-100)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const wasOffline = useRef(false);

  useEffect(() => {
    if (!isOnline) {
      wasOffline.current = true;
      setShowBackOnline(false);
      setVisible(true);
      Animated.parallel([
        Animated.timing(translateY, {
          toValue: 0,
          duration: ANIMATION_DURATION_MS,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: ANIMATION_DURATION_MS,
          useNativeDriver: true,
        }),
      ]).start();
    } else if (wasOffline.current) {
      // Just came back online
      wasOffline.current = false;

      // First show "Back online" briefly
      setShowBackOnline(true);

      // Then hide after a delay
      const timer = setTimeout(() => {
        Animated.parallel([
          Animated.timing(translateY, {
            toValue: -100,
            duration: ANIMATION_DURATION_MS,
            useNativeDriver: true,
          }),
          Animated.timing(opacity, {
            toValue: 0,
            duration: ANIMATION_DURATION_MS,
            useNativeDriver: true,
          }),
        ]).start(() => {
          setVisible(false);
          setShowBackOnline(false);
        });
      }, BACK_ONLINE_DURATION_MS);

      return () => clearTimeout(timer);
    } else {
      // Initially online — nothing to show
      setVisible(false);
    }
  }, [isOnline, translateY, opacity]);

  if (!visible) return null;

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor: showBackOnline ? "#22c55e" : "#e11d48",
          paddingTop: insets.top + 10,
          transform: [{ translateY }],
          opacity,
        },
      ]}
      accessibilityRole="alert"
      accessibilityLabel={
        showBackOnline ? "Back online" : "You are offline"
      }
    >
      <View style={styles.content}>
        <Text style={styles.icon}>
          {showBackOnline ? "✓" : "⚠️"}
        </Text>
        <Text style={styles.text}>
          {showBackOnline
            ? "Back online — syncing..."
            : "You are offline — showing cached data"}
        </Text>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 9999,
    // paddingTop is set dynamically via useSafeAreaInsets
    paddingBottom: 10,
    paddingHorizontal: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 8,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  icon: {
    fontSize: 18,
  },
  text: {
    color: "#fff",
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
  },
});
