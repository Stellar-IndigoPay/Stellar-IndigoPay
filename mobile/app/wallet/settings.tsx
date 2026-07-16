/**
 * app/wallet/settings.tsx
 *
 * Wallet settings — view secret key (biometric gated), delete wallet, network info.
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { loadSecretKey, deleteSecretKey } from "../../lib/wallet/sdk";

export default function WalletSettingsScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { session, isAuthenticated, clear } = useAuth();

  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const publicKey = session?.publicKey;

  const revealKey = async () => {
    setLoading(true);
    try {
      const key = await loadSecretKey();
      setRevealedKey(key);
    } catch {
      Alert.alert("Error", "Could not access wallet keys.");
    } finally {
      setLoading(false);
    }
  };

  const hideKey = () => setRevealedKey(null);

  const handleDeleteWallet = () => {
    Alert.alert(
      "Delete Wallet",
      "This will remove ALL wallet data from this device. Make sure you have your secret key backed up.\n\nThis action cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Wallet",
          style: "destructive",
          onPress: async () => {
            setDeleting(true);
            try {
              await deleteSecretKey();
              await clear();
              router.replace("/onboarding/create" as `${string}`);
            } catch (err) {
              Alert.alert("Error", "Failed to delete wallet. Please try again.");
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  if (!isAuthenticated || !publicKey) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          Unlock the app to view wallet settings.
        </Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Wallet info */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Wallet Info</Text>

        <View style={[styles.infoRow, { borderColor: colors.border }]}>
          <Text style={[styles.infoLabel, { color: colors.secondaryText }]}>Public Key</Text>
          <Text style={[styles.infoValue, { color: colors.primaryText }]} numberOfLines={2}>
            {publicKey}
          </Text>
        </View>

        <View style={[styles.infoRow, { borderColor: colors.border }]}>
          <Text style={[styles.infoLabel, { color: colors.secondaryText }]}>Network</Text>
          <Text style={[styles.infoValue, { color: colors.primaryText }]}>
            {session.network === "PUBLIC" ? "Stellar Mainnet" : "Stellar Testnet"}
          </Text>
        </View>
      </View>

      {/* Secret key */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: colors.primaryText }]}>Secret Key</Text>
        <Text style={[styles.sectionDesc, { color: colors.secondaryText }]}>
          Your secret key gives full control of your wallet. Never share it.
        </Text>

        {revealedKey ? (
          <View style={[styles.keyCard, { backgroundColor: colors.surface, borderColor: "#f59e0b" }]}>
            <Text style={[styles.keyValue, { color: colors.primaryText }]} selectable>
              {revealedKey}
            </Text>
            <TouchableOpacity style={[styles.smallBtn, { marginTop: 12 }]} onPress={hideKey}>
              <Text style={[styles.smallBtnText, { color: colors.primary }]}>Hide Key</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.primary }]}
            onPress={revealKey}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={styles.btnText}>Reveal Secret Key</Text>
            )}
          </TouchableOpacity>
        )}
      </View>

      {/* Danger zone */}
      <View style={styles.section}>
        <Text style={[styles.sectionTitle, { color: "#ef4444" }]}>Danger Zone</Text>
        <TouchableOpacity
          style={[styles.dangerBtn, { borderColor: "#ef4444" }]}
          onPress={handleDeleteWallet}
          disabled={deleting}
        >
          {deleting ? (
            <ActivityIndicator color="#ef4444" />
          ) : (
            <Text style={styles.dangerBtnText}>Delete Wallet</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: "center", alignItems: "center", padding: 20 },
  emptyText: { fontSize: 16 },
  section: { padding: 20 },
  sectionTitle: { fontSize: 18, fontWeight: "bold", marginBottom: 4 },
  sectionDesc: { fontSize: 13, marginBottom: 16, lineHeight: 18 },
  infoRow: { paddingVertical: 14, borderBottomWidth: 1 },
  infoLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 2 },
  infoValue: { fontSize: 14, fontFamily: "monospace" },
  keyCard: { borderWidth: 1.5, borderRadius: 12, padding: 16, marginBottom: 12 },
  keyValue: { fontSize: 14, fontFamily: "monospace", lineHeight: 20 },
  btn: { padding: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  smallBtn: { padding: 8, alignItems: "center" },
  smallBtnText: { fontWeight: "700", fontSize: 14 },
  dangerBtn: {
    borderWidth: 1.5,
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  dangerBtnText: { color: "#ef4444", fontWeight: "700", fontSize: 16 },
});
