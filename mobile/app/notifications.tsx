import React, { useEffect, useState } from "react";
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  LayoutAnimation,
  Platform,
  UIManager,
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
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
    UIManager.setLayoutAnimationEnabledExperimental(true);
  }

  const toggleGroup = (projectId: string) => {
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setExpandedGroups(prev => ({ ...prev, [projectId]: !prev[projectId] }));
  };

  const groupedNotifications = React.useMemo(() => {
    const groups: Record<string, InboxNotification[]> = {};
    const others: InboxNotification[] = [];
    
    notifications.forEach(n => {
      const key = n.projectId || 'other';
      if (key === 'other') {
        others.push(n);
      } else {
        if (!groups[key]) groups[key] = [];
        groups[key].push(n);
      }
    });
    
    const result: any[] = [];
    Object.entries(groups).forEach(([projectId, items]) => {
      if (items.length === 1) {
        result.push({ type: 'item', item: items[0] });
      } else {
        result.push({ type: 'group', projectId, items });
      }
    });
    others.forEach(item => result.push({ type: 'item', item }));
    
    // Sort by most recent
    result.sort((a, b) => {
      const tsA = a.type === 'group' ? Math.max(...a.items.map((i: any) => i.timestamp)) : a.item.timestamp;
      const tsB = b.type === 'group' ? Math.max(...b.items.map((i: any) => i.timestamp)) : b.item.timestamp;
      return tsB - tsA;
    });
    
    return result;
  }, [notifications]);


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

  const renderItemContent = (item: InboxNotification) => (
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

  const renderItem = ({ item }: { item: any }) => {
    if (item.type === 'item') {
      return renderItemContent(item.item);
    }
    
    // Group
    const isExpanded = expandedGroups[item.projectId];
    const unreadCount = item.items.filter((i: any) => !i.read).length;
    
    return (
      <View style={{ marginBottom: 12 }}>
        <TouchableOpacity
          onPress={() => toggleGroup(item.projectId)}
          style={[styles.groupHeader, { backgroundColor: colors.surface, borderColor: colors.border }]}
        >
          <Text style={{ flex: 1, fontWeight: 'bold', color: colors.text }}>
            Project Updates ({item.items.length})
          </Text>
          {unreadCount > 0 && (
            <View style={styles.groupBadge}>
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: 'bold' }}>{unreadCount}</Text>
            </View>
          )}
          <Text style={{ color: colors.secondaryText, fontSize: 12 }}>
            {isExpanded ? 'Collapse ▲' : 'Expand ▼'}
          </Text>
        </TouchableOpacity>
        
        {isExpanded ? (
          <View style={{ paddingLeft: 12, borderLeftWidth: 2, borderLeftColor: colors.border, marginLeft: 8 }}>
            {item.items.map((i: any) => (
              <View key={i.id} style={{ marginBottom: -8 }}>
                {renderItemContent(i)}
              </View>
            ))}
          </View>
        ) : null}
      </View>
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
        data={groupedNotifications}
        keyExtractor={(item) => item.type === "group" ? "group_" + item.projectId : item.item.id}
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
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  groupBadge: {
    backgroundColor: '#008080',
    borderRadius: 12,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginRight: 8,
  },

});
