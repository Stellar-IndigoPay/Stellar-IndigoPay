/**
 * app/wallet/send.tsx
 *
 * Send XLM screen — enter destination address, amount, sign with biometric gate.
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TextInput,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
  ScrollView,
} from "react-native";
import { useRouter } from "expo-router";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import { useBiometricAuth } from "../../hooks/useBiometricAuth";
import { loadSecretKey, buildPaymentTransaction, signTransaction, submitTransaction, isValidPublicKey } from "../../lib/wallet/sdk";

export default function SendScreen() {
  const { colors } = useTheme();
  const router = useRouter();
  const { session, isAuthenticated } = useAuth();
  const bio = useBiometricAuth();

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const publicKey = session?.publicKey;

  if (!isAuthenticated || !publicKey) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          Unlock your wallet to send XLM.
        </Text>
      </View>
    );
  }

  const handleSend = async () => {
    setStatus(null);

    if (!destination.trim()) {
      Alert.alert("Error", "Please enter a destination address.");
      return;
    }
    if (!isValidPublicKey(destination.trim())) {
      Alert.alert("Error", "Invalid Stellar address.");
      return;
    }
    const sendAmount = parseFloat(amount);
    if (!amount || isNaN(sendAmount) || sendAmount <= 0) {
      Alert.alert("Error", "Please enter a valid amount.");
      return;
    }

    setSending(true);
    try {
      // Biometric gate
      const confirmed = await bio.confirmDonation(sendAmount);
      if (!confirmed.success) {
        Alert.alert("Cancelled", "Transaction was not confirmed.");
        return;
      }

      const secretKey = await loadSecretKey();
      if (!secretKey) {
        Alert.alert("Error", "Could not access wallet keys. Please unlock again.");
        return;
      }

      const xdr = await buildPaymentTransaction({
        sourcePublicKey: publicKey,
        destination: destination.trim(),
        amount: sendAmount.toFixed(7),
        memo: memo.trim() || undefined,
      });

      const { signedXDR, transactionHash } = signTransaction(xdr, secretKey);
      const result = await submitTransaction(signedXDR);

      setStatus({
        type: "success",
        msg: `Sent ${sendAmount} XLM! Tx: ${result.hash.slice(0, 10)}...`,
      });
      setDestination("");
      setAmount("");
      setMemo("");
    } catch (err: any) {
      setStatus({
        type: "error",
        msg: err?.message || "Transaction failed.",
      });
    } finally {
      setSending(false);
    }
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} keyboardShouldPersistTaps="handled">
      <View style={styles.card}>
        <Text style={[styles.label, { color: colors.primaryText }]}>From</Text>
        <Text style={[styles.fromAddress, { color: colors.secondaryText }]}>
          {publicKey.slice(0, 12)}...{publicKey.slice(-8)}
        </Text>

        <Text style={[styles.label, { color: colors.primaryText, marginTop: 16 }]}>
          Destination Address
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.primaryText }]}
          placeholder="G..."
          placeholderTextColor={colors.placeholder}
          value={destination}
          onChangeText={setDestination}
          autoCapitalize="none"
          autoCorrect={false}
        />

        <Text style={[styles.label, { color: colors.primaryText, marginTop: 12 }]}>
          Amount (XLM)
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.primaryText }]}
          placeholder="0.0"
          placeholderTextColor={colors.placeholder}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
        />

        <Text style={[styles.label, { color: colors.primaryText, marginTop: 12 }]}>
          Memo (optional)
        </Text>
        <TextInput
          style={[styles.input, { backgroundColor: colors.inputBackground, borderColor: colors.inputBorder, color: colors.primaryText }]}
          placeholder="What's this for?"
          placeholderTextColor={colors.placeholder}
          value={memo}
          onChangeText={setMemo}
          maxLength={28}
        />
      </View>

      {status && (
        <View style={[styles.statusBox, status.type === "success" ? styles.successBox : styles.errorBox]}>
          <Text style={styles.statusText}>{status.msg}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[styles.sendBtn, { backgroundColor: sending ? colors.muted : colors.primary }]}
        onPress={handleSend}
        disabled={sending}
      >
        {sending ? (
          <ActivityIndicator color="#fff" />
        ) : (
          <Text style={styles.sendBtnText}>Send XLM</Text>
        )}
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  centered: { justifyContent: "center", alignItems: "center", padding: 20 },
  emptyText: { fontSize: 16 },
  card: { margin: 16, padding: 20 },
  label: { fontSize: 14, fontWeight: "600", marginBottom: 6 },
  fromAddress: { fontSize: 14, fontFamily: "monospace" },
  input: { borderWidth: 1, borderRadius: 10, padding: 14, fontSize: 16, marginBottom: 4 },
  statusBox: { marginHorizontal: 16, padding: 14, borderRadius: 12, marginTop: 8 },
  successBox: { backgroundColor: "#ecfdf5", borderColor: "#34d399", borderWidth: 1 },
  errorBox: { backgroundColor: "#fef2f2", borderColor: "#f87171", borderWidth: 1 },
  statusText: { color: "#0f172a", fontSize: 14 },
  sendBtn: { margin: 16, padding: 16, borderRadius: 12, alignItems: "center" },
  sendBtnText: { color: "#fff", fontSize: 18, fontWeight: "bold" },
});
