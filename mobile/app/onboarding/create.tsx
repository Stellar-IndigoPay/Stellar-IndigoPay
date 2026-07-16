/**
 * app/onboarding/create.tsx
 *
 * New wallet creation flow: generate keypair, show mnemonic, confirm backup.
 * On completion, stores the wallet session via AuthProvider.storeSession().
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  Alert,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { generateWallet, storeSecretKey } from "../../lib/wallet/sdk";

type Step = "intro" | "generating" | "show_mnemonic" | "confirming";

export default function CreateWalletScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { storeSession, isAuthenticated } = useAuth();

  const [step, setStep] = useState<Step>("intro");
  const [wallet, setWallet] = useState<ReturnType<typeof generateWallet> | null>(null);
  const [hasBackedUp, setHasBackedUp] = useState(false);

  const handleCreate = () => {
    setStep("generating");
    // Slight delay so the spinner renders
    setTimeout(() => {
      try {
        const newWallet = generateWallet();
        setWallet(newWallet);
        setStep("show_mnemonic");
      } catch (err: any) {
        Alert.alert("Error", err?.message || "Failed to generate wallet.");
        setStep("intro");
      }
    }, 600);
  };

  const handleFinish = async () => {
    if (!wallet) return;

    setStep("confirming");
    try {
      // Store the secret key with biometric protection
      const stored = await storeSecretKey(wallet.secretKey);
      if (!stored) {
        Alert.alert("Error", "Failed to securely store wallet keys. Please try again.");
        setStep("show_mnemonic");
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
        setStep("show_mnemonic");
      }
    } catch (err: any) {
      Alert.alert("Error", err?.message || "An unexpected error occurred.");
      setStep("show_mnemonic");
    }
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      {step === "intro" && (
        <View style={styles.section}>
          <Text style={[styles.emoji, { textAlign: "center" }]}>🛡️</Text>
          <Text style={[styles.title, { color: colors.primaryText, textAlign: "center" }]}>
            Create Your Wallet
          </Text>
          <Text style={[styles.desc, { color: colors.secondaryText, textAlign: "center" }]}>
            A new Stellar wallet will be generated and securely stored on your device.
            Your keys never leave this device.
          </Text>
          <View style={[styles.infoBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            <Text style={[styles.infoTitle, { color: colors.primaryText }]}>You will receive:</Text>
            <Text style={[styles.bullet, { color: colors.secondaryText }]}>• A recovery phrase to backup your wallet</Text>
            <Text style={[styles.bullet, { color: colors.secondaryText }]}>• Keys stored with biometric protection</Text>
            <Text style={[styles.bullet, { color: colors.secondaryText }]}>• Full control — no custodians, no middlemen</Text>
          </View>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.primary }]}
            onPress={handleCreate}
          >
            <Text style={styles.btnText}>Generate Wallet</Text>
          </TouchableOpacity>
        </View>
      )}

      {step === "generating" && (
        <View style={[styles.section, styles.centered]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.desc, { color: colors.secondaryText, marginTop: 20, textAlign: "center" }]}>
            Generating your secure Stellar wallet...
          </Text>
        </View>
      )}

      {step === "show_mnemonic" && wallet && (
        <View style={styles.section}>
          <Text style={[styles.title, { color: colors.primaryText, textAlign: "center" }]}>
            Your Recovery Phrase
          </Text>
          <Text style={[styles.desc, { color: colors.secondaryText, textAlign: "center" }]}>
            Write down these 12 words in order. Keep them safe and offline.
            This is the ONLY way to recover your wallet.
          </Text>

          <View style={[styles.warningBox, { borderColor: "#f59e0b", backgroundColor: "#fffbeb" }]}>
            <Text style={styles.warningText}>
              ⚠️ Never share your recovery phrase. IndigoPay will never ask for it.
            </Text>
          </View>

          <View style={[styles.mnemonicCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {wallet.mnemonic.split(" ").map((word, i) => (
              <View key={i} style={[styles.wordChip, { backgroundColor: colors.inputBackground }]}>
                <Text style={[styles.wordIndex, { color: colors.muted }]}>{i + 1}</Text>
                <Text style={[styles.wordText, { color: colors.primaryText }]}>{word}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity
            style={[styles.btn, { backgroundColor: hasBackedUp ? colors.primary : colors.muted, marginTop: 20 }]}
            onPress={() => setHasBackedUp(!hasBackedUp)}
          >
            <Text style={styles.btnText}>
              {hasBackedUp ? "✓ I have saved my recovery phrase" : "I have written down my recovery phrase"}
            </Text>
          </TouchableOpacity>

          {hasBackedUp && (
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.primary, marginTop: 12 }]}
              onPress={handleFinish}
            >
              <Text style={styles.btnText}>Continue to Wallet</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {step === "confirming" && (
        <View style={[styles.section, styles.centered]}>
          <ActivityIndicator size="large" color={colors.primary} />
          <Text style={[styles.desc, { color: colors.secondaryText, marginTop: 20, textAlign: "center" }]}>
            Securing your wallet...
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  section: { padding: 24, paddingTop: 40 },
  centered: { justifyContent: "center", alignItems: "center", minHeight: 300 },
  emoji: { fontSize: 48, marginBottom: 16 },
  title: { fontSize: 24, fontWeight: "bold", marginBottom: 12 },
  desc: { fontSize: 14, lineHeight: 20, marginBottom: 24 },
  infoBox: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 24 },
  infoTitle: { fontSize: 15, fontWeight: "700", marginBottom: 8 },
  bullet: { fontSize: 13, lineHeight: 22 },
  warningBox: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 20 },
  warningText: { color: "#92400e", fontSize: 13, fontWeight: "600" },
  mnemonicCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  wordChip: {
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 10,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  wordIndex: { fontSize: 11, fontWeight: "700" },
  wordText: { fontSize: 14, fontWeight: "600" },
  btn: { padding: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
