/**
 * app/wallet/receive.tsx
 *
 * Receive screen — show wallet address + QR code for receiving XLM.
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Share,
} from "react-native";
import { useAuth } from "../../providers/AuthProvider";
import { useTheme } from "../theme";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";

export default function ReceiveScreen() {
  const { colors } = useTheme();
  const { session } = useAuth();
  const [copied, setCopied] = useState(false);

  const publicKey = session?.publicKey;

  const copyAddress = async () => {
    if (!publicKey) return;
    await Clipboard.setStringAsync(publicKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const shareAddress = async () => {
    if (!publicKey) return;
    await Share.share({ message: publicKey });
  };

  if (!publicKey) {
    return (
      <View style={[styles.container, styles.centered, { backgroundColor: colors.background }]}>
        <Text style={[styles.emptyText, { color: colors.secondaryText }]}>
          No wallet connected.
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <View style={styles.qrContainer}>
        <View style={[styles.qrCard, { backgroundColor: "#fff", borderColor: colors.border }]}>
          <QRCode
            value={publicKey}
            size={220}
            backgroundColor="white"
            color="#000"
          />
        </View>
        <Text style={[styles.qrHint, { color: colors.secondaryText }]}>
          Scan to send XLM to this wallet
        </Text>
      </View>

      <View style={[styles.addressCard, { backgroundColor: colors.surface, borderColor: colors.border }]}>
        <Text style={[styles.addressLabel, { color: colors.secondaryText }]}>
          Wallet Address
        </Text>
        <Text style={[styles.addressValue, { color: colors.primaryText }]} selectable>
          {publicKey}
        </Text>
      </View>

      <View style={styles.buttonRow}>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.primary }]}
          onPress={copyAddress}
        >
          <Text style={styles.btnText}>{copied ? "Copied!" : "Copy Address"}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, styles.btnOutline, { borderColor: colors.primary }]}
          onPress={shareAddress}
        >
          <Text style={[styles.btnOutlineText, { color: colors.primary }]}>Share</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20 },
  centered: { justifyContent: "center", alignItems: "center" },
  emptyText: { fontSize: 16 },
  qrContainer: { alignItems: "center", marginTop: 24 },
  qrCard: {
    padding: 16,
    borderRadius: 16,
    borderWidth: 2,
    marginBottom: 12,
  },
  qrHint: { fontSize: 13, marginBottom: 24 },
  addressCard: {
    borderRadius: 12,
    borderWidth: 1,
    padding: 16,
    marginBottom: 20,
  },
  addressLabel: { fontSize: 12, fontWeight: "700", textTransform: "uppercase", marginBottom: 6 },
  addressValue: { fontSize: 14, fontFamily: "monospace", lineHeight: 20 },
  buttonRow: { flexDirection: "row", gap: 12 },
  btn: {
    flex: 1,
    padding: 14,
    borderRadius: 10,
    alignItems: "center",
  },
  btnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  btnOutline: {
    backgroundColor: "transparent",
    borderWidth: 1.5,
  },
  btnOutlineText: { fontWeight: "700", fontSize: 15 },
});
