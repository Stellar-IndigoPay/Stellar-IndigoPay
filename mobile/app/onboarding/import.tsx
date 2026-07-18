/**
 * app/onboarding/import.tsx
 *
 * Import wallet from a Stellar secret key (S…) or 12-word mnemonic phrase.
 * Stores the key securely and creates the AuthProvider session.
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { importWallet, storeSecretKey } from "../../lib/wallet/sdk";

export default function ImportWalletScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { storeSession } = useAuth();

  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const handleImport = async () => {
    const trimmed = input.trim();
    if (!trimmed) {
      Alert.alert("Error", "Please enter a secret key or recovery phrase.");
      return;
    }

    setLoading(true);
    try {
      const wallet = importWallet(trimmed);

      // Store the secret key with biometric protection
      const stored = await storeSecretKey(wallet.secretKey);
      if (!stored) {
        Alert.alert("Error", "Failed to securely store wallet keys.");
        return;
      }

      // Persist the session
      const ok = await storeSession({
        publicKey: wallet.publicKey,
        network: "TESTNET",
        authNonce: "",
        lastLoginAt: Date.now(),
      });

      if (ok) {
        router.replace("/wallet" as `${string}`);
      } else {
        Alert.alert("Error", "Failed to save wallet session.");
      }
    } catch (err: any) {
      Alert.alert(
        "Import Failed",
        err?.message || "Could not import wallet. Check your input and try again.",
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.background }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.section}>
        <Text style={[styles.emoji, { textAlign: "center" }]}>🔐</Text>
        <Text style={[styles.title, { color: colors.primaryText, textAlign: "center" }]}>
          Import Wallet
        </Text>
        <Text style={[styles.desc, { color: colors.secondaryText, textAlign: "center" }]}>
          Enter your Stellar secret key (starting with S) or a 12-word recovery phrase
          to restore your wallet.
        </Text>

        <View style={[styles.warningBox, { borderColor: "#f59e0b", backgroundColor: "#fffbeb" }]}>
          <Text style={styles.warningText}>
            ⚠️ Only import wallets on devices you trust. Never paste your secret key into
            unverified apps or websites.
          </Text>
        </View>

        <Text style={[styles.label, { color: colors.primaryText }]}>
          Secret Key or Recovery Phrase
        </Text>
        <TextInput
          style={[
            styles.textArea,
            {
              backgroundColor: colors.inputBackground,
              borderColor: colors.inputBorder,
              color: colors.primaryText,
            },
          ]}
          placeholder="S… or word1 word2 word3 …"
          placeholderTextColor={colors.placeholder}
          value={input}
          onChangeText={setInput}
          multiline
          numberOfLines={4}
          autoCapitalize="none"
          autoCorrect={false}
          textAlignVertical="top"
        />

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: loading ? colors.muted : colors.primary }]}
          onPress={handleImport}
          disabled={loading}
        >
          {loading ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.btnText}>Import Wallet</Text>
          )}
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { padding: 24, paddingTop: 40 },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 24, fontWeight: "bold", marginBottom: 12 },
  desc: { fontSize: 14, lineHeight: 20, marginBottom: 24 },
  warningBox: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 24 },
  warningText: { color: "#92400e", fontSize: 13, fontWeight: "600" },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 8 },
  textArea: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    fontSize: 16,
    minHeight: 120,
    fontFamily: "monospace",
    lineHeight: 22,
    marginBottom: 20,
  },
  btn: { padding: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
