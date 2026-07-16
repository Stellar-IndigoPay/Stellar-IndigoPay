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
import {
  setupNotificationListener,
  setupNotificationResponseListener,
} from "../utils/notifications";
import { ErrorBoundary } from "../components/ErrorBoundary";
import { AuthProvider } from "../providers/AuthProvider";
import { init as initErrorReporter } from "../lib/errorReporter";

function DeepLinkHandler() {
  useDeepLink();
  return null;
}

function NotificationHandler() {
  const router = useRouter();

  useEffect(() => {
    // Foreground notification display listener
    const receivedSub = setupNotificationListener();

    // Tap-on-notification → navigate to project detail (#483)
    const responseSub = setupNotificationResponseListener((path) =>
      router.push(path as any),
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
