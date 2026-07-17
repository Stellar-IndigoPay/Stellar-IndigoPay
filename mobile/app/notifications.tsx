import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from "react-native";
import { useRouter } from "expo-router";
import { useTheme } from "./theme";
import {
  getInboxNotifications,
  markInboxNotificationRead,
  markAllInboxNotificationsRead,
  clearInboxNotifications,
  navigateToNotification,
  InboxNotification,
} from "../utils/notifications";

export default function NotificationsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const [notifications, setNotifications] = useState<InboxNotification[]>([]);
  const [loading, setLoading] = useState(true);

  async function loadNotifications() {
    setLoading(true);
    const list = await getInboxNotifications();
    setNotifications(list);
    setLoading(false);
  }

  useEffect(() => {
    loadNotifications();
  }, []);

  const handleMarkAllRead = async () => {
    await markAllInboxNotificationsRead();
    await loadNotifications();
  };

  const handleClearAll = async () => {
    await clearInboxNotifications();
    setNotifications([]);
  };

  const handleTapNotification = async (item: InboxNotification) => {
    await markInboxNotificationRead(item.id);
    // Refresh local list state
    setNotifications((prev) =>
      prev.map((n) => (n.id === item.id ? { ...n, read: true } : n)),
    );
    // Navigate using the notification payload
    const data = {
      type: item.type,
      projectId: item.projectId,
      donationId: item.donationId,
      donorAddress: item.donorAddress,
      url: item.url,
    };
    navigateToNotification(data, (path) => router.push(path as any));
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case "donation_receipt":
        return "💖";
      case "project_update":
        return "📢";
      case "milestone_reached":
        return "🏆";
      case "subscription_due":
        return "📅";
      default:
        return "🔔";
    }
  };

  const formatTimestamp = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const renderItem = ({ item }: { item: InboxNotification }) => {
    return (
      <TouchableOpacity
        onPress={() => handleTapNotification(item)}
        style={[
          styles.card,
          {
            backgroundColor: item.read
              ? colors.cardBackground || colors.background
              : colors.unreadBackground || "rgba(0,128,128,0.06)",
            borderColor: colors.border,
          },
        ]}
        accessibilityLabel={`${item.title || "Notification"}. ${item.body || ""}. ${item.read ? "Read" : "Unread"}`}
        accessibilityRole="button"
      >
        <View style={styles.cardHeader}>
          <Text style={styles.icon}>{getTypeIcon(item.type)}</Text>
          <View style={styles.titleContainer}>
            <Text
              style={[
                styles.title,
                {
                  color: colors.text,
                  fontWeight: item.read ? "500" : "800",
                },
              ]}
            >
              {item.title || "New Notification"}
            </Text>
            <Text style={[styles.time, { color: colors.secondaryText }]}>
              {formatTimestamp(item.timestamp)}
            </Text>
          </View>
          {!item.read && <View style={styles.unreadDot} />}
        </View>
        <Text style={[styles.body, { color: colors.secondaryText }]}>
          {item.body || "No details provided."}
        </Text>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={[styles.actionsRow, { borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={handleMarkAllRead}
          disabled={notifications.length === 0}
          style={[styles.actionBtn, { opacity: notifications.length === 0 ? 0.5 : 1 }]}
          accessibilityLabel="Mark all read"
          accessibilityRole="button"
        >
          <Text style={[styles.actionText, { color: colors.primary }]}>
            Mark all read
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={handleClearAll}
          disabled={notifications.length === 0}
          style={[styles.actionBtn, { opacity: notifications.length === 0 ? 0.5 : 1 }]}
          accessibilityLabel="Clear all"
          accessibilityRole="button"
        >
          <Text style={[styles.actionText, { color: "#ef4444" }]}>
            Clear all
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.emptyContainer}>
            <Text style={{ fontSize: 48, marginBottom: 12 }}>📭</Text>
            <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
              Your inbox is clean. No notifications yet!
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  actionBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  actionText: {
    fontSize: 14,
    fontWeight: "700",
  },
  list: {
    padding: 16,
    paddingBottom: 32,
  },
  card: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 12,
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: 8,
  },
  icon: {
    fontSize: 22,
    marginRight: 12,
  },
  titleContainer: {
    flex: 1,
  },
  title: {
    fontSize: 15,
  },
  time: {
    fontSize: 11,
    marginTop: 2,
  },
  unreadDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#008080",
    marginLeft: 8,
  },
  body: {
    fontSize: 13,
    lineHeight: 18,
    paddingLeft: 34,
  },
  emptyContainer: {
    alignItems: "center",
    justifyContent: "center",
    paddingTop: 64,
  },
  emptyText: {
    fontSize: 14,
    textAlign: "center",
  },
});
