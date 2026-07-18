/**
 * app/_layout.tsx
 * Root layout for the mobile app using expo-router
 */
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useColorScheme } from "react-native";
import { useEffect } from "react";
import { useRouter } from "expo-router";
import { ThemeProvider, themes } from "./theme";
import { useDeepLink } from "../hooks/useDeepLink";
import * as Notifications from "expo-notifications";
import {
  setupNotificationListener,
  isNotificationHandled,
  saveNotificationFromExpo,
  navigateToNotification,
} from "../utils/notifications";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { AuthProvider } from "../providers/AuthProvider";
import { init as initErrorReporter } from "../lib/errorReporter";
import ConnectivityBanner from "../components/ConnectivityBanner";
import { initConnectivity } from "../lib/connectivity";
import { cache } from "../lib/offlineCache";

function DeepLinkHandler() {
  useDeepLink();
  return null;
}

function NotificationHandler() {
  const router = useRouter();

  useEffect(() => {
    // 1. Cold start handling: check if the app was launched by a notification tap
    Notifications.getLastNotificationResponseAsync().then(async (response) => {
      if (response) {
        const id = response.notification.request.identifier;
        if (!isNotificationHandled(id)) {
          await saveNotificationFromExpo(response.notification);
          navigateToNotification(
            response.notification.request.content.data,
            (path) => router.push(path as any),
          );
        }
      }
    });

    // 2. Foreground notifications
    const receivedSub = setupNotificationListener();

    // 3. Response tap notifications (warm starts)
    const responseSub = Notifications.addNotificationResponseReceivedListener(
      async (response) => {
        const id = response.notification.request.identifier;
        if (!isNotificationHandled(id)) {
          await saveNotificationFromExpo(response.notification);
          navigateToNotification(
            response.notification.request.content.data,
            (path) => router.push(path as any),
          );
        }
      },
    );

    return () => {
      receivedSub.remove();
      responseSub.remove();
    };
  }, [router]);

  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const themeMode = colorScheme === "dark" ? "dark" : "light";
  const theme = themes[themeMode];

  // Best-effort optional-SDK init: silently fall through when
  // @sentry/react-native is not installed (CI / dev / OSS forks).
  useEffect(() => {
    void initErrorReporter();
    // Initialise offline-first subsystems
    initConnectivity();
    void cache.init();
  }, []);

  return (
    <ErrorBoundary>
      <ThemeProvider>
        {/* Deep-link + notification handlers sit ABOVE AuthProvider so
            they can navigate the router even when no session is
            active. AuthGate will then present the locked UI for any
            arriving gated route. */}
        <DeepLinkHandler />
        <NotificationHandler />
        <AuthProvider>
          <StatusBar style={theme.statusBarStyle} />
          {/* Connectivity banner overlays everything — renders as an
              absolute-positioned alert bar at the very top. */}
          <ConnectivityBanner />
          <Stack
            screenOptions={{
              headerStyle: { backgroundColor: theme.header },
              headerTintColor: theme.headerText,
              headerTitleStyle: { fontFamily: "Lora_700Bold" },
            }}
          >
            <Stack.Screen name="index" options={{ title: "Home" }} />
            <Stack.Screen name="settings" options={{ title: "Settings" }} />
            <Stack.Screen
              name="settings/notifications"
              options={{ title: "Notification Settings" }}
            />
            <Stack.Screen name="projects" options={{ title: "Projects" }} />
            <Stack.Screen
              name="projects/[id]"
              options={{ title: "Project Details" }}
            />
            <Stack.Screen name="donate/[id]" options={{ title: "Donate" }} />
            <Stack.Screen name="impact" options={{ title: "My Impact" }} />
            <Stack.Screen
              name="profile/[address]"
              options={{ title: "Donor Profile" }}
            />
            <Stack.Screen
              name="leaderboard"
              options={{ title: "Leaderboard" }}
            />
            <Stack.Screen
              name="recurring"
              options={{ title: "Monthly Giving" }}
            />
            <Stack.Screen
              name="notifications"
              options={{ title: "Notifications" }}
            />
            <Stack.Screen
              name="scan"
              options={{ title: "Scan to Donate", headerShown: false }}
            />
            <Stack.Screen name="wallet" options={{ title: "Wallet" }} />
            <Stack.Screen
              name="wallet/receive"
              options={{ title: "Receive" }}
            />
            <Stack.Screen
              name="wallet/send"
              options={{ title: "Send" }}
            />
            <Stack.Screen
              name="wallet/backup"
              options={{ title: "Backup Wallet" }}
            />
            <Stack.Screen
              name="wallet/settings"
              options={{ title: "Wallet Settings" }}
            />
            <Stack.Screen
              name="onboarding/create"
              options={{ title: "Create Wallet", headerShown: false }}
            />
            <Stack.Screen
              name="onboarding/import"
              options={{ title: "Import Wallet", headerShown: false }}
            />
            <Stack.Screen
              name="wallet/sep0007"
              options={{ title: "Confirm Transaction" }}
            />
          </Stack>
        </AuthProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}
