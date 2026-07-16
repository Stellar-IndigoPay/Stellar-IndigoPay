/**
 * app/wallet/index.tsx
 *
 * Wallet dashboard — balance, quick actions (send/receive), recent activity.
 * Requires an unlocked AuthProvider session.
 */
import { useEffect, useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { getBalance, WalletBalance } from "../../lib/wallet/sdk";
import * as Clipboard from "expo-clipboard";

const API_URL = process.env.EXPO_PUBLIC_API_URL || "http://localhost:4000";

export default function WalletScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { session, isAuthenticated } = useAuth();

  const [balance, setBalance] = useState<WalletBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);

  const publicKey = session?.publicKey || null;

  const loadBalance = async () => {
    if (!publicKey) return;
    try {
      const bal = await getBalance(publicKey);
      setBalance(bal);
    } catch (err) {
      console.error("Balance fetch failed:", err);
    }
  };

  useEffect(() => {
    if (isAuthenticated && publicKey) {
      setLoading(true);
      loadBalance().finally(() => setLoading(false));
    } else if (!isAuthenticated) {
      setLoading(false);
    }
  }, [isAuthenticated, publicKey]);

  const onRefresh = async () => {
    setRefreshing(true);
    await loadBalance();
    setRefreshing(false);
  };

  const copyAddress = async () => {
    if (!publicKey) return;
    await Clipboard.setStringAsync(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isAuthenticated || !publicKey) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyTitle, { color: colors.primaryText }]}>
          Wallet Locked
        </Text>
        <Text style={[styles.emptySub, { color: colors.secondaryText }]}>
          Unlock the app to view your wallet.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} />
      }
    >
      {/* Balance card */}
      <View style={[styles.balanceCard, { backgroundColor: colors.primary }]}>
        <Text style={styles.balanceLabel}>Total Balance</Text>
        {loading ? (
          <ActivityIndicator color="#fff" style={{ marginTop: 8 }} />
        ) : (
          <Text style={styles.balanceAmount}>
            {balance?.xlm || "0"} XLM
          </Text>
        )}
        <TouchableOpacity style={styles.addressRow} onPress={copyAddress}>
          <Text style={styles.addressText}>
            {publicKey.slice(0, 12)}...{publicKey.slice(-8)}
          </Text>
          <Text style={styles.copyIcon}>{copied ? "✓" : "📋"}</Text>
        </TouchableOpacity>
      </View>

      {/* Quick actions */}
      <View style={styles.actionsRow}>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => router.push("/wallet/send" as `${string}`)}
        >
          <Text style={styles.actionIcon}>↗</Text>
          <Text style={[styles.actionLabel, { color: colors.primaryText }]}>Send</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => router.push("/wallet/receive" as `${string}`)}
        >
          <Text style={styles.actionIcon}>↓</Text>
          <Text style={[styles.actionLabel, { color: colors.primaryText }]}>Receive</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => router.push("/wallet/backup" as `${string}`)}
        >
          <Text style={styles.actionIcon}>🔑</Text>
          <Text style={[styles.actionLabel, { color: colors.primaryText }]}>Backup</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => router.push("/wallet/settings" as `${string}`)}
        >
          <Text style={styles.actionIcon}>⚙</Text>
          <Text style={[styles.actionLabel, { color: colors.primaryText }]}>Settings</Text>
        </TouchableOpacity>
      </View>

      {/* Donate shortcut */}
      <TouchableOpacity
        style={[styles.donateBanner, { backgroundColor: colors.surface, borderColor: colors.primary }]}
        onPress={() => router.push("/donate/scan" as `${string}`)}
      >
        <Text style={[styles.donateText, { color: colors.primary }]}>
          🌱 Donate to a Climate Project
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: "center", alignItems: "center", padding: 20 },
  emptyTitle: { fontSize: 20, fontWeight: "bold", marginBottom: 8 },
  emptySub: { fontSize: 14, textAlign: "center" },
  balanceCard: {
    margin: 16,
    borderRadius: 16,
    padding: 24,
    alignItems: "center",
  },
  balanceLabel: { color: "rgba(255,255,255,0.8)", fontSize: 14 },
  balanceAmount: { color: "#fff", fontSize: 36, fontWeight: "bold", marginTop: 4 },
  addressRow: { flexDirection: "row", alignItems: "center", marginTop: 12, gap: 6 },
  addressText: { color: "rgba(255,255,255,0.9)", fontSize: 14, fontFamily: "monospace" },
  copyIcon: { color: "#fff", fontSize: 16 },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginHorizontal: 16,
    marginBottom: 12,
  },
  actionBtn: {
    alignItems: "center",
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    minWidth: 72,
  },
  actionIcon: { fontSize: 22, marginBottom: 4 },
  actionLabel: { fontSize: 12, fontWeight: "600" },
  donateBanner: {
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: "center",
  },
  donateText: { fontSize: 16, fontWeight: "700" },
});
