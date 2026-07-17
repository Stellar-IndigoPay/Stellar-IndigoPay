/**
 * utils/notifications.ts
 * Push notification setup and helpers
 */
import * as Notifications from "expo-notifications";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform, Linking as RNLinking } from "react-native";
import * as Linking from "expo-linking";

// Configure notification behavior
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
  }),
});

const LAST_SEEN_KEY = "indigopay:notifications:lastSeen";

/**
 * Request notification permissions
 */
export async function requestNotificationPermissions(): Promise<string | null> {
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== "granted") {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== "granted") {
    console.log("Failed to get push token for push notification!");
    return null;
  }

  return finalStatus;
}

/**
 * Get the device's push token
 */
export async function getPushToken(): Promise<string | null> {
  try {
    const permissionStatus = await requestNotificationPermissions();
    if (!permissionStatus) return null;

    const token = await Notifications.getExpoPushTokenAsync({
      projectId: process.env.EXPO_PUBLIC_PROJECT_ID || "",
    });

    return token.data;
  } catch (error) {
    console.error("Error getting push token:", error);
    return null;
  }
}

/**
 * Register device token with backend
 */
export async function registerDeviceToken(
  token: string,
  walletAddress?: string,
): Promise<boolean> {
  try {
    const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";
    const platform = Platform.OS;

    await fetch(`${API_URL}/api/notifications/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        token,
        platform,
        walletAddress,
      }),
    });

    console.log("Device token registered successfully");
    return true;
  } catch (error) {
    console.error("Error registering device token:", error);
    return false;
  }
}

/**
 * Follow a project.
 *
 * Calls both endpoints in parallel:
 *  1. POST /api/notifications/follow  — registers the push-token follow so the
 *     device receives project update notifications.
 *  2. POST /api/projects/:id/follows  — wallet-address follow for the REST API
 *     (issue #399); only sent when walletAddress is provided.
 *
 * Returns true only when all attempted calls succeed.
 */
export async function followProject(
  projectId: string,
  token: string,
  walletAddress?: string,
): Promise<boolean> {
  try {
    const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

    const calls: Promise<Response>[] = [
      fetch(`${API_URL}/api/notifications/follow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, token, walletAddress }),
      }),
    ];

    // Wire up the REST follows endpoint when we have a wallet address.
    if (walletAddress) {
      calls.push(
        fetch(
          `${API_URL}/api/projects/${encodeURIComponent(projectId)}/follows`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ walletAddress }),
          },
        ),
      );
    }

    await Promise.all(calls);
    console.log(`Followed project ${projectId}`);
    return true;
  } catch (error) {
    console.error("Error following project:", error);
    return false;
  }
}

/**
 * Unfollow a project.
 *
 * Mirrors followProject: calls both unfollow endpoints in parallel.
 */
export async function unfollowProject(
  projectId: string,
  token: string,
  walletAddress?: string,
): Promise<boolean> {
  try {
    const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

    const calls: Promise<Response>[] = [
      fetch(`${API_URL}/api/notifications/unfollow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, token }),
      }),
    ];

    if (walletAddress) {
      calls.push(
        fetch(
          `${API_URL}/api/projects/${encodeURIComponent(projectId)}/follows`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ walletAddress }),
          },
        ),
      );
    }

    await Promise.all(calls);
    console.log(`Unfollowed project ${projectId}`);
    return true;
  } catch (error) {
    console.error("Error unfollowing project:", error);
    return false;
  }
}

/**
 * Get all projects followed by the device
 */
export async function getFollowedProjects(token: string): Promise<any[]> {
  try {
    const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

    const response = await fetch(
      `${API_URL}/api/notifications/follows?token=${encodeURIComponent(token)}`,
    );
    const data = await response.json();

    if (data.success) {
      return data.data;
    }

    return [];
  } catch (error) {
    console.error("Error getting followed projects:", error);
    return [];
  }
}

/**
 * Get the timestamp used as the unread notification cutoff.
 */
export async function getNotificationLastSeen(): Promise<string | null> {
  return AsyncStorage.getItem(LAST_SEEN_KEY);
}

export async function markNotificationsSeen(
  date = new Date(),
): Promise<string> {
  const timestamp = date.toISOString();
  await AsyncStorage.setItem(LAST_SEEN_KEY, timestamp);
  return timestamp;
}

export async function getUnreadNotificationCount(
  token: string,
): Promise<number> {
  try {
    const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";
    const lastSeen = await getNotificationLastSeen();
    const params = new URLSearchParams({ token });
    if (lastSeen) params.set("lastSeen", lastSeen);

    const response = await fetch(
      `${API_URL}/api/notifications/unread-count?${params.toString()}`,
    );
    if (!response.ok) return 0;

    const data = await response.json();
    const count = Number(data.unreadCount);
    return Number.isFinite(count) ? count : 0;
  } catch (error) {
    console.error("Error getting unread notification count:", error);
    return 0;
  }
}

/**
 * Set up notification listener
 */
export function setupNotificationListener(
  onUnreadCountChange?: (count: number) => void,
) {
  const subscription = Notifications.addNotificationReceivedListener(
    async (notification) => {
      console.log("Notification received:", notification);
      await saveNotificationFromExpo(notification);
      const currentBadge = await Notifications.getBadgeCountAsync().catch(
        () => 0,
      );
      const nextBadge = currentBadge + 1;
      await Notifications.setBadgeCountAsync(nextBadge).catch(() => undefined);
      onUnreadCountChange?.(nextBadge);
    },
  );

  return subscription;
}

const handledNotificationIds = new Set<string>();

/**
 * Check if a notification has already been handled to prevent duplicates
 */
export function isNotificationHandled(id: string): boolean {
  if (handledNotificationIds.has(id)) {
    return true;
  }
  handledNotificationIds.add(id);
  if (handledNotificationIds.size > 100) {
    const firstElement = handledNotificationIds.values().next().value;
    if (firstElement !== undefined) {
      handledNotificationIds.delete(firstElement);
    }
  }
  return false;
}

/**
 * Parses deep links like indigopay://project/123 -> /projects/123
 */
export function parseDeepLinkUrl(url: string): string | null {
  try {
    const parsed = Linking.parse(url);
    const path = parsed.path;
    if (!path) return null;
    const [segment, param] = path.replace(/^\//, "").split("/");
    if (!param) return null;
    if (segment === "project") {
      return `/projects/${param}`;
    } else if (segment === "donate") {
      return `/donate/${param}`;
    }
  } catch (e) {
    console.error("Failed to parse deep link url:", e);
  }
  return null;
}

/**
 * Navigate according to notification payload structure
 */
export function navigateToNotification(
  data: Record<string, any> | undefined,
  push: (path: string) => void,
) {
  if (!data) {
    push("/");
    return;
  }

  const { type, projectId, donorAddress, url } = data;

  if (url && typeof url === "string") {
    if (url.startsWith("indigopay://")) {
      const parsed = parseDeepLinkUrl(url);
      if (parsed) {
        push(parsed);
        return;
      }
    } else if (url.startsWith("http://") || url.startsWith("https://")) {
      RNLinking.openURL(url).catch((err) =>
        console.error("Error opening URL:", err),
      );
      return;
    }
  }

  switch (type) {
    case "donation_receipt":
      if (donorAddress) {
        push(`/profile/${donorAddress}`);
      } else if (projectId) {
        push(`/projects/${projectId}`);
      } else {
        push("/");
      }
      break;
    case "project_update":
    case "milestone_reached":
      if (projectId) {
        push(`/projects/${projectId}`);
      } else {
        push("/");
      }
      break;
    case "subscription_due":
      if (projectId) {
        push(`/donate/${projectId}`);
      } else {
        push("/");
      }
      break;
    default:
      push("/");
  }
}

/**
 * Set up notification response listener for deep-link navigation (#483).
 * When the user taps a push notification that contains a projectId, navigate
 * directly to that project's detail screen. Governance proposals with a
 * proposalId deep-link to the governance screen (when available).
 *
 * @param push - router.push function from expo-router
 * @returns the subscription (call .remove() on cleanup)
 */
export function setupNotificationResponseListener(
  push: (path: string) => void,
) {
  const subscription = Notifications.addNotificationResponseReceivedListener(
    (response) => {
      const data = response.notification.request.content.data as Record<
        string,
        unknown
      >;
      const type = data?.type as string | undefined;
      const projectId = data?.projectId as string | undefined;
      const proposalId = data?.proposalId as string | undefined;

      if (type === "governance_proposal" && proposalId) {
        // TODO: Replace with dedicated governance voting screen when available.
        // For now, navigate to the project detail if a projectId is also present.
        if (projectId) {
          push(`/projects/${projectId}`);
        }
        return;
      }

      if (projectId) {
        push(`/projects/${projectId}`);
      }
    },
  );

  return subscription;
}

const INBOX_KEY = "indigopay:notifications:inbox";

export interface InboxNotification {
  id: string;
  type: string;
  title?: string;
  body?: string;
  timestamp: number;
  read: boolean;
  projectId?: string;
  donationId?: string;
  donorAddress?: string;
  url?: string;
}

export async function getInboxNotifications(): Promise<InboxNotification[]> {
  try {
    const raw = await AsyncStorage.getItem(INBOX_KEY);
    if (!raw) return [];
    const list = JSON.parse(raw);
    if (Array.isArray(list)) {
      return list.sort((a, b) => b.timestamp - a.timestamp);
    }
    return [];
  } catch (error) {
    console.error("Error loading inbox notifications:", error);
    return [];
  }
}

export async function saveInboxNotifications(
  notifications: InboxNotification[],
): Promise<void> {
  try {
    await AsyncStorage.setItem(INBOX_KEY, JSON.stringify(notifications));
  } catch (error) {
    console.error("Error saving inbox notifications:", error);
  }
}

export async function addInboxNotification(
  notification: InboxNotification,
): Promise<void> {
  try {
    const current = await getInboxNotifications();
    if (current.some((n) => n.id === notification.id)) {
      return;
    }
    const updated = [notification, ...current];
    await saveInboxNotifications(updated.slice(0, 50));
  } catch (error) {
    console.error("Error adding inbox notification:", error);
  }
}

export async function saveNotificationFromExpo(
  notification: Notifications.Notification,
): Promise<void> {
  const id = notification.request.identifier;
  const { title, body, data } = notification.request.content;
  const type = (data?.type as string) || "unknown";
  const projectId = data?.projectId as string | undefined;
  const donationId = data?.donationId as string | undefined;
  const donorAddress = data?.donorAddress as string | undefined;
  const url = data?.url as string | undefined;

  await addInboxNotification({
    id,
    type,
    title: title || undefined,
    body: body || undefined,
    timestamp: Date.now(),
    read: false,
    projectId,
    donationId,
    donorAddress,
    url,
  });
}

export async function markInboxNotificationRead(id: string): Promise<void> {
  try {
    const current = await getInboxNotifications();
    const updated = current.map((n) =>
      n.id === id ? { ...n, read: true } : n,
    );
    await saveInboxNotifications(updated);
  } catch (error) {
    console.error("Error marking inbox notification as read:", error);
  }
}

export async function markAllInboxNotificationsRead(): Promise<void> {
  try {
    const current = await getInboxNotifications();
    const updated = current.map((n) => ({ ...n, read: true }));
    await saveInboxNotifications(updated);
  } catch (error) {
    console.error("Error marking all inbox notifications as read:", error);
  }
}

export async function clearInboxNotifications(): Promise<void> {
  try {
    await AsyncStorage.removeItem(INBOX_KEY);
  } catch (error) {
    console.error("Error clearing inbox notifications:", error);
  }
}
