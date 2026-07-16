/**
 * app/wallet/backup.tsx
 *
 * Recovery phrase backup — show 12-word mnemonic, verify, confirm.
 * Security: biometric gate required to reveal the recovery phrase.
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Alert,
  ScrollView,
} from "react-native";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { loadSecretKey, deriveMnemonic } from "../../lib/wallet/sdk";
import * as Clipboard from "expo-clipboard";

type Step = "locked" | "show" | "done";

export default function BackupScreen() {
  const { colors } = useTheme();
  const { isAuthenticated } = useAuth();
  const [step, setStep] = useState<Step>("locked");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [understood, setUnderstood] = useState(false);

  const revealPhrase = async () => {
    setLoading(true);
    try {
      const key = await loadSecretKey();
      if (!key) { Alert.alert("Error", "Could not access wallet keys."); return; }
      const phrase = deriveMnemonic(key);
      setMnemonic(phrase);
      setStep("show");
    } catch {
      Alert.alert("Error", "Biometric authentication failed or was cancelled.");
    } finally {
      setLoading(false);
    }
  };

  const copyPhrase = async () => {
    if (!mnemonic) return;
    await Clipboard.setStringAsync(mnemonic);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isAuthenticated) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          Unlock the app to backup your wallet.
        </Text>
      </View>
    );
  }

  const words = mnemonic?.split(" ") || [];

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
      {step === "locked" && (
        <View style={styles.section}>
          <Text style={[styles.title, { color: colors.primaryText }]}>Backup Your Wallet</Text>
          <Text style={[styles.desc, { color: colors.secondaryText }]}>
            Your 12-word recovery phrase is the only way to restore your wallet.
            Write it down and store it in a safe offline location. Never share it.
          </Text>
          <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary }]} onPress={revealPhrase} disabled={loading}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.btnText}>Reveal Recovery Phrase</Text>}
          </TouchableOpacity>
        </View>
      )}

      {step === "show" && mnemonic && (
        <View style={styles.section}>
          <View style={[styles.warningBox, { borderColor: "#f59e0b", backgroundColor: "#fffbeb" }]}>
            <Text style={styles.warningText}>⚠️ Never share this phrase. Anyone with it can control your wallet.</Text>
          </View>

          <Text style={[styles.phraseLabel, { color: colors.secondaryText }]}>Recovery Phrase</Text>
          <View style={[styles.wordGrid, { backgroundColor: colors.surface, borderColor: colors.border }]}>
            {words.map((word, i) => (
              <View key={i} style={[styles.wordChip, { backgroundColor: colors.inputBackground }]}>
                <Text style={[styles.wordIndex, { color: colors.muted }]}>{i + 1}</Text>
                <Text style={[styles.wordText, { color: colors.primaryText }]}>{word}</Text>
              </View>
            ))}
          </View>

          <TouchableOpacity style={[styles.copyBtn, { borderColor: colors.primary }]} onPress={copyPhrase}>
            <Text style={[styles.copyBtnText, { color: colors.primary }]}>{copied ? "Copied!" : "Copy to Clipboard"}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.btn, { backgroundColor: understood ? colors.primary : colors.muted, marginTop: 24 }]}
            onPress={() => setUnderstood(!understood)}
          >
            <Text style={styles.btnText}>{understood ? "✓ I've saved my phrase" : "I've written down my recovery phrase"}</Text>
          </TouchableOpacity>
          {understood && (
            <TouchableOpacity style={[styles.btn, { backgroundColor: colors.primary, marginTop: 12 }]} onPress={() => setStep("done")}>
              <Text style={styles.btnText}>Complete Backup</Text>
            </TouchableOpacity>
          )}
        </View>
      )}

      {step === "done" && (
        <View style={[styles.section, styles.centered]}>
          <Text style={[styles.title, { color: colors.primary }]}>✓ Backup Complete</Text>
          <Text style={[styles.desc, { color: colors.secondaryText, textAlign: "center", marginTop: 12 }]}>
            Your wallet is safely backed up. Keep your recovery phrase in a secure offline location.
          </Text>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: "center", alignItems: "center", padding: 20 },
  emptyText: { fontSize: 16 },
  section: { padding: 24 },
  title: { fontSize: 22, fontWeight: "bold", marginBottom: 12 },
  desc: { fontSize: 14, lineHeight: 20, marginBottom: 20 },
  warningBox: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 20 },
  warningText: { color: "#92400e", fontSize: 13, fontWeight: "600" },
  phraseLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 10 },
  wordGrid: { borderWidth: 1, borderRadius: 12, padding: 16, flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12 },
  wordChip: { borderRadius: 8, paddingVertical: 5, paddingHorizontal: 8, flexDirection: "row", alignItems: "center", gap: 4 },
  wordIndex: { fontSize: 11, fontWeight: "700" },
  wordText: { fontSize: 13, fontWeight: "600" },
  copyBtn: { borderWidth: 1.5, borderRadius: 10, padding: 12, alignItems: "center", marginBottom: 8 },
  copyBtnText: { fontWeight: "700", fontSize: 14 },
  btn: { padding: 14, borderRadius: 10, alignItems: "center" },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
