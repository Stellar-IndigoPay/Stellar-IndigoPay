/**
 * app/index.tsx
 * Home screen — live project list fetched from /api/projects
 */
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Linking } from "react-native";
import axios from "axios";
import * as Notifications from "expo-notifications";
import { useTheme } from "./theme";
import { getCachedData, setCachedData } from "../utils/cache";
import {
  getPushToken,
  getUnreadNotificationCount,
  setupNotificationListener,
} from "../utils/notifications";
import DonationQueueStatus from "../components/DonationQueueStatus";
import { startQueueWorker, stopQueueWorker } from "../utils/donationQueueWorker";
import SyncStatusIcon from "../components/SyncStatusIcon";
import OfflineQueueIndicator from "../components/OfflineQueueIndicator";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";
const CACHE_KEY_PROJECTS = "home:projects_list";

interface ClimateProject {
  id: string;
  name: string;
  description: string;
  category: string;
  goalXLM: string;
  raisedXLM: string;
  donorCount: number;
  verified: boolean;
  status: string;
}

function SkeletonCard({
  colors,
}: {
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: colors.surface, borderColor: colors.cardBorder },
      ]}
    >
      <View
        style={[
          styles.skeletonLine,
          { width: "40%", backgroundColor: colors.border },
        ]}
      />
      <View
        style={[
          styles.skeletonLine,
          {
            width: "70%",
            marginTop: 8,
            height: 18,
            backgroundColor: colors.border,
          },
        ]}
      />
      <View
        style={[
          styles.skeletonLine,
          { width: "90%", marginTop: 6, backgroundColor: colors.border },
        ]}
      />
      <View
        style={[
          styles.skeletonLine,
          { width: "60%", marginTop: 6, backgroundColor: colors.border },
        ]}
      />
      <View
        style={[
          styles.skeletonProgress,
          { backgroundColor: colors.border, marginTop: 14 },
        ]}
      />
    </View>
  );
}

function ProjectCard({
  project,
  colors,
  onPress,
}: {
  project: ClimateProject;
  colors: ReturnType<typeof useTheme>["colors"];
  onPress: () => void;
}) {
  const progress = (() => {
    const r = parseFloat(project.raisedXLM);
    const g = parseFloat(project.goalXLM);
    if (!g || isNaN(r) || isNaN(g)) return 0;
    return Math.min(100, Math.round((r / g) * 100));
  })();

  return (
    <TouchableOpacity
      style={[
        styles.card,
        {
          backgroundColor: colors.surface,
          borderColor: colors.cardBorder,
          shadowColor: colors.cardShadow,
        },
      ]}
      onPress={onPress}
      activeOpacity={0.8}
      accessibilityLabel={`View ${project.name} project`}
      accessibilityRole="button"
    >
      <View style={styles.cardHeader}>
        <Text style={[styles.category, { color: colors.primary }]}>
          {project.category}
        </Text>
        <View style={styles.badgeRow}>
          {project.verified && (
            <View
              style={[
                styles.verifiedBadge,
                { backgroundColor: colors.primary },
              ]}
            >
              <Text style={styles.verifiedText}>✓ Verified</Text>
            </View>
          )}
        </View>
      </View>

      <Text
        style={[styles.projectName, { color: colors.primaryText }]}
        numberOfLines={1}
      >
        {project.name}
      </Text>
      <Text
        style={[styles.projectDescription, { color: colors.secondaryText }]}
        numberOfLines={2}
      >
        {project.description}
      </Text>

      <View style={styles.progressContainer}>
        <View style={[styles.progressBar, { backgroundColor: colors.border }]}>
          <View
            style={[
              styles.progressFill,
              { width: `${progress}%`, backgroundColor: colors.primary },
            ]}
          />
        </View>
        <View style={styles.progressRow}>
          <Text style={[styles.progressText, { color: colors.secondaryText }]}>
            {parseFloat(project.raisedXLM).toFixed(0)} /{" "}
            {parseFloat(project.goalXLM).toFixed(0)} XLM
          </Text>
          <Text style={[styles.donorCount, { color: colors.muted }]}>
            {project.donorCount} donors
          </Text>
        </View>
      </View>
    </TouchableOpacity>
  );
}

export default function HomeScreen() {
  const router = useRouter();
  const { colors } = useTheme();
  const [projects, setProjects] = useState<ClimateProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [networkError, setNetworkError] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [stats, setStats] = useState<{ totalDonations: number; totalXLMRaised: string } | null>(null);
 
  const loadProjects = useCallback(async (isPullRefresh = false) => {
    if (isPullRefresh) setRefreshing(true);
    setNetworkError(false);
 
    try {
      const res = await axios.get(`${API_URL}/api/projects`);
      const data: ClimateProject[] = res.data.data ?? res.data;
      setProjects(Array.isArray(data) ? data : [data]);
      await setCachedData(CACHE_KEY_PROJECTS, data);
    } catch {
      const cached = await getCachedData<ClimateProject[]>(CACHE_KEY_PROJECTS);
      if (cached) {
        setProjects(cached.data);
      } else {
        setNetworkError(true);
      }
    }
 
    try {
      const statsRes = await axios.get(`${API_URL}/api/stats/global`);
      const statsData = statsRes.data.data ?? statsRes.data;
      setStats(statsData);
    } catch (e) {
      console.warn("Error fetching global stats:", e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);
 
  useEffect(() => {
    loadProjects();
    // Start the offline donation queue retry worker (module-level singleton)
    startQueueWorker();
    return () => {
      // Cleanup worker when component unmounts
      stopQueueWorker();
    };
  }, [loadProjects]);

  useEffect(() => {
    let active = true;

    async function loadUnreadCount() {
      const token = await getPushToken();
      if (!token) return;

      const count = await getUnreadNotificationCount(token);
      if (active) {
        setUnreadCount(count);
        await Notifications.setBadgeCountAsync(count).catch(() => undefined);
      }
    }

    loadUnreadCount();
    const subscription = setupNotificationListener(setUnreadCount);

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  const renderSkeleton = () => (
    <FlatList
      data={[1, 2, 3, 4, 5]}
      keyExtractor={(item: number) => String(item)}
      renderItem={() => <SkeletonCard colors={colors} />}
      contentContainerStyle={styles.listContent}
      scrollEnabled={false}
      ListHeaderComponent={
        <Header
          colors={colors}
          unreadCount={unreadCount}
          onPressNotifications={() => router.push("/notifications" as `${string}`)}
          stats={stats}
        />
      }
    />
  );
 
  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={{ position: "absolute", opacity: 0 }}>Loading...</Text>
        {renderSkeleton()}
        <DonationQueueStatus />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <FlatList
        data={projects}
        keyExtractor={(item: ClimateProject) => item.id}
        renderItem={({ item }: { item: ClimateProject }) => (
          <ProjectCard
            project={item}
            colors={colors}
            onPress={() => router.push(`/projects/${item.id}`)}
          />
        )}
        contentContainerStyle={styles.listContent}
        ListHeaderComponent={
          <Header
            colors={colors}
            unreadCount={unreadCount}
            onPressNotifications={() => router.push("/notifications" as `${string}`)}
            stats={stats}
          />
        }
        ListEmptyComponent={
          networkError ? (
            <View style={styles.errorContainer}>
              <Text style={[styles.errorText, { color: colors.secondaryText }]}>
                Unable to load projects. Check your connection.
              </Text>
              <TouchableOpacity
                style={[
                  styles.retryButton,
                  { backgroundColor: colors.primary },
                ]}
                onPress={() => {
                  setLoading(true);
                  loadProjects();
                }}
                accessibilityLabel="Retry loading projects"
                accessibilityRole="button"
              >
                <Text style={[styles.retryText, { color: colors.buttonText }]}>
                  Retry
                </Text>
              </TouchableOpacity>
            </View>
          ) : (
            <Text style={[styles.emptyText, { color: colors.muted }]}>
              No projects found.
            </Text>
          )
        }
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => loadProjects(true)}
            tintColor={colors.primary}
            colors={[colors.primary]}
          />
        }
        ListFooterComponent={<Footer colors={colors} />}
        showsVerticalScrollIndicator={false}
      />
      <DonationQueueStatus />
      {/* Offline queue indicator — appears when items are queued for sync */}
      <OfflineQueueIndicator />
    </View>
  );
}

function Footer({
  colors,
}: {
  colors: ReturnType<typeof useTheme>["colors"];
}) {
  return (
    <View style={[styles.footer, { borderTopColor: colors.border }]}>
      <Text style={[styles.footerText, { color: colors.muted }]}>
        Open source · MIT License{" "}
      </Text>
      <TouchableOpacity
        onPress={() =>
          Linking.openURL("https://t.me/StellarIndigoPay").catch(() => {})
        }
        accessibilityLabel="Join our Telegram community"
        accessibilityRole="link"
      >
        <Text style={[styles.footerLink, { color: colors.primary }]}>
          💬 Join our Telegram →
        </Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() =>
          Linking.openURL(
            "https://github.com/Stellar-IndigoPay/Stellar-IndigoPay",
          ).catch(() => {})
        }
        accessibilityLabel="Contribute on GitHub"
        accessibilityRole="link"
      >
        <Text
          style={[
            styles.footerLink,
            { color: colors.primary, marginTop: 6 },
          ]}
        >
          Contribute on GitHub →
        </Text>
      </TouchableOpacity>
    </View>
  );
}

function Header({
  colors,
  unreadCount,
  onPressNotifications,
  stats,
}: {
  colors: ReturnType<typeof useTheme>["colors"];
  unreadCount: number;
  onPressNotifications: () => void;
  stats: { totalDonations: number; totalXLMRaised: string } | null;
}) {
  const router = useRouter();
  return (
    <View style={[styles.header, { backgroundColor: colors.primary }]}>
      <View style={styles.headerTitleRow}>
        <Text style={[styles.title, { color: colors.headerText }]}>
          Stellar IndigoPay
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          {unreadCount > 0 && (
            <View style={styles.unreadBadge}>
              <Text style={styles.unreadBadgeText}>
                {unreadCount > 99 ? "99+" : unreadCount}
              </Text>
            </View>
          )}
          <TouchableOpacity
            onPress={() => router.push("/settings" as `${string}`)}
            accessibilityLabel="Open settings screen"
            accessibilityRole="button"
          >
            <Text style={{ fontSize: 22, color: colors.headerText }}>⚙️</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={[styles.subtitle, { color: colors.headerText }]}>
        Climate donations on Stellar
      </Text>
 
      {stats && (
        <View style={styles.statsRow}>
          <View style={styles.statBox}>
            <Text style={[styles.statText, { color: colors.headerText }]}>
              <Text style={styles.statNum}>{stats.totalXLMRaised}</Text> XLM raised
            </Text>
          </View>
          <View style={styles.statBox}>
            <Text style={[styles.statText, { color: colors.headerText }]}>
              <Text style={styles.statNum}>{stats.totalDonations}</Text> donations
            </Text>
          </View>
        </View>
      )}
 
      <Text style={[styles.browseTitle, { color: colors.browseText || colors.headerText }]}>
        Browse All Projects
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  listContent: {
    paddingBottom: 24,
  },
  header: {
    padding: 24,
    marginBottom: 8,
  },
  headerTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  unreadBadge: {
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    paddingHorizontal: 7,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  unreadBadgeText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
  },
  subtitle: {
    fontSize: 16,
    marginTop: 4,
  },
  bellBtn: {
    position: "relative",
    padding: 6,
  },
  bellBadge: {
    position: "absolute",
    right: -4,
    top: -4,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  bellBadgeText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "800",
  },
  statsRow: {
    flexDirection: "row",
    marginTop: 18,
    backgroundColor: "rgba(255,255,255,0.12)",
    borderRadius: 8,
    padding: 12,
    gap: 24,
  },
  statBox: {
    flex: 1,
  },
  statText: {
    fontSize: 12,
    opacity: 0.9,
  },
  statNum: {
    fontSize: 18,
    fontWeight: "800",
  },
  statLbl: {
    fontSize: 11,
    textTransform: "uppercase",
    marginTop: 2,
  },
  browseTitle: {
    fontSize: 18,
    fontWeight: "700",
    marginTop: 16,
  },
  card: {
    marginHorizontal: 16,
    marginBottom: 12,
    borderRadius: 12,
    padding: 16,
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
    borderWidth: 1,
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 6,
  },
  category: {
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  badgeRow: {
    flexDirection: "row",
    gap: 4,
  },
  verifiedBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
  },
  verifiedText: {
    fontSize: 10,
    fontWeight: "700",
    color: "#fff",
  },
  projectName: {
    fontSize: 17,
    fontWeight: "bold",
    marginBottom: 4,
  },
  projectDescription: {
    fontSize: 13,
    lineHeight: 18,
  },
  progressContainer: {
    marginTop: 12,
  },
  progressBar: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 3,
  },
  progressRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 4,
  },
  progressText: {
    fontSize: 11,
  },
  donorCount: {
    fontSize: 11,
  },
  errorContainer: {
    alignItems: "center",
    paddingTop: 48,
    paddingHorizontal: 32,
  },
  errorText: {
    fontSize: 15,
    textAlign: "center",
    marginBottom: 20,
    lineHeight: 22,
  },
  retryButton: {
    paddingHorizontal: 28,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryText: {
    fontSize: 15,
    fontWeight: "600",
  },
  emptyText: {
    textAlign: "center",
    marginTop: 48,
    fontSize: 15,
  },
  footer: {
    alignItems: "center",
    paddingVertical: 24,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    marginTop: 8,
  },
  footerText: {
    fontSize: 12,
    marginBottom: 4,
  },
  footerLink: {
    fontSize: 13,
    fontWeight: "600",
  },
  skeletonLine: {
    height: 12,
    borderRadius: 6,
  },
  skeletonProgress: {
    height: 6,
    borderRadius: 3,
    width: "100%",
  },
});
